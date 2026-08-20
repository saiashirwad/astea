import { Effect, FileSystem, Path } from "effect"
import { asApplicationFailure } from "./Failure.ts"
import { APPLY_JOURNAL_NAME, parseJournal, type JournalEntry } from "./Journal.ts"
import { isContained, resolveContainedPath } from "./PathSafety.ts"

const isSafemodsTemporaryName = (name: string): boolean =>
  name.includes(".safemods-") && name.endsWith(".tmp")

const sweepSafemodsTemporaries = (
  workspaceRoot: string,
  planId: string,
): Effect.Effect<
  void,
  ReturnType<typeof asApplicationFailure>,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = yield* fs
      .readDirectory(workspaceRoot, { recursive: true })
      .pipe(Effect.mapError((cause) => asApplicationFailure(planId, cause)))
    for (const name of names) {
      if (!isSafemodsTemporaryName(name)) continue
      const target = path.resolve(workspaceRoot, name)
      if (!isContained(path, workspaceRoot, target)) continue
      yield* fs.remove(target, { force: true }).pipe(Effect.ignore)
    }
  })

const restoreJournalEntry = (
  workspaceRoot: string,
  planId: string,
  entry: JournalEntry,
): Effect.Effect<
  void,
  ReturnType<typeof asApplicationFailure>,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (entry.temporary !== undefined) {
      const temporary = resolveContainedPath(path, workspaceRoot, entry.temporary)
      if (temporary !== undefined) {
        yield* fs.remove(temporary, { force: true }).pipe(Effect.ignore)
      }
    }
    const target = resolveContainedPath(path, workspaceRoot, entry.target)
    if (target === undefined) {
      return yield* asApplicationFailure(planId, `Journal path escapes workspace: ${entry.target}`)
    }
    yield* entry.before.exists
      ? fs
          .writeFileString(target, entry.before.text ?? "")
          .pipe(Effect.mapError((cause) => asApplicationFailure(planId, cause)))
      : fs.remove(target, { force: true }).pipe(Effect.ignore)
  })

export const recoverUnfinishedApplication = (
  workspaceRoot: string,
  planId: string,
): Effect.Effect<
  void,
  ReturnType<typeof asApplicationFailure>,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const journalPath = path.join(workspaceRoot, APPLY_JOURNAL_NAME)
    const exists = yield* fs
      .exists(journalPath)
      .pipe(Effect.mapError((cause) => asApplicationFailure(planId, cause)))
    if (exists) {
      const text = yield* fs
        .readFileString(journalPath)
        .pipe(Effect.mapError((cause) => asApplicationFailure(planId, cause)))
      const journal = parseJournal(text)
      if (journal !== undefined && journal.phase !== "committed") {
        for (const entry of journal.files) {
          yield* restoreJournalEntry(workspaceRoot, planId, entry)
        }
        for (const directory of [...journal.createdDirectories].reverse()) {
          const target = resolveContainedPath(path, workspaceRoot, directory)
          if (target !== undefined) {
            yield* fs.remove(target, { force: true }).pipe(Effect.ignore)
          }
        }
      }
      yield* fs.remove(journalPath, { force: true }).pipe(Effect.ignore)
    }
    yield* sweepSafemodsTemporaries(workspaceRoot, planId)
  })
