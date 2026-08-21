import { randomUUID } from "node:crypto"
import { Effect, FileSystem, Predicate } from "effect"
import type { Json } from "../../Evidence/index.ts"
import { asApplicationFailure } from "./Failure.ts"

export const APPLY_JOURNAL_NAME = ".safemods-apply.journal"

export interface JournalBeforeState {
  readonly exists: boolean
  readonly text?: string
}

export interface JournalEntry {
  readonly target: string
  readonly temporary?: string
  readonly before: JournalBeforeState
}

export interface TransactionJournal {
  readonly planId: string
  readonly phase: "open" | "committed"
  readonly files: ReadonlyArray<JournalEntry>
  readonly createdDirectories: ReadonlyArray<string>
}

const asRecord = (value: Json): Readonly<Record<string, Json>> | undefined => {
  if (!Predicate.isObject(value)) return undefined
  return value
}

const parseJournalBefore = (value: Json): JournalBeforeState | undefined => {
  const record = asRecord(value)
  if (record === undefined || !Predicate.isBoolean(record.exists)) return undefined
  if (!record.exists) return { exists: false }
  if (record.text !== undefined && !Predicate.isString(record.text)) return undefined
  return { exists: true, text: Predicate.isString(record.text) ? record.text : "" }
}

const parseJournalEntry = (value: Json): JournalEntry | undefined => {
  const record = asRecord(value)
  if (record === undefined || !Predicate.isString(record.target)) return undefined
  if (record.before === undefined) return undefined
  const before = parseJournalBefore(record.before)
  if (before === undefined) return undefined
  if (record.temporary !== undefined && !Predicate.isString(record.temporary)) return undefined
  return record.temporary === undefined
    ? { target: record.target, before }
    : { target: record.target, temporary: record.temporary, before }
}

export const parseJournal = (text: string): TransactionJournal | undefined => {
  let value: Json
  try {
    // SAFETY: journal files are persisted as JSON by persistJournal.
    value = JSON.parse(text) as Json
  } catch {
    return undefined
  }
  const record = asRecord(value)
  if (record === undefined || !Predicate.isString(record.planId) || !Array.isArray(record.files)) {
    return undefined
  }
  const files: Array<JournalEntry> = []
  for (const entry of record.files) {
    // SAFETY: record.files is verified to be an array above from the parsed journal JSON.
    const parsed = parseJournalEntry(entry as Json)
    if (parsed === undefined) return undefined
    files.push(parsed)
  }
  const createdDirectories = Array.isArray(record.createdDirectories)
    ? record.createdDirectories.filter(Predicate.isString)
    : []
  const phase = record.phase === "committed" ? "committed" : "open"
  return { planId: record.planId, phase, files, createdDirectories }
}

export const persistJournal = (
  journalPath: string,
  journal: TransactionJournal,
): Effect.Effect<void, ReturnType<typeof asApplicationFailure>, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const temporary = `${journalPath}.${randomUUID()}.tmp`
    yield* fs
      .writeFileString(temporary, JSON.stringify(journal), { flag: "wx" })
      .pipe(Effect.mapError((cause) => asApplicationFailure(journal.planId, cause)))
    yield* fs.rename(temporary, journalPath).pipe(
      Effect.mapError((cause) => asApplicationFailure(journal.planId, cause)),
      Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
    )
  })
