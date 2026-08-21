/** Evidence identity, merging, and completion for draft operations. */
import { Data, Effect } from "effect"
import type { EvidenceRecord } from "./Evidence.ts"
import { canonicalJson } from "./Canonical.ts"

export class DraftEvidenceConflict extends Data.TaggedError("DraftEvidenceConflict")<{
  readonly id: string
}> {}

const evidenceIdentity = (record: EvidenceRecord): string =>
  `${record.kind}\0${canonicalJson(record.facts)}`

/** Keep identical records; reject the same ID with different kind or facts. */
export const mergeEvidence = (
  records: ReadonlyArray<EvidenceRecord>,
): ReadonlyArray<EvidenceRecord> => {
  const evidence = new Map<string, EvidenceRecord>()
  for (const record of records) {
    const existing = evidence.get(record.id)
    if (existing === undefined) {
      evidence.set(record.id, record)
      continue
    }
    if (evidenceIdentity(existing) !== evidenceIdentity(record)) {
      throw new DraftEvidenceConflict({ id: record.id })
    }
  }
  return [...evidence.values()]
}

/** Effect form of `mergeEvidence` for typed recipe failures. */
export const mergeEvidenceEffect = (
  records: ReadonlyArray<EvidenceRecord>,
): Effect.Effect<ReadonlyArray<EvidenceRecord>, DraftEvidenceConflict> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(mergeEvidence(records))
    } catch (cause) {
      return cause instanceof DraftEvidenceConflict ? Effect.fail(cause) : Effect.die(cause)
    }
  })

interface EvidenceReference {
  readonly evidenceIds?: ReadonlyArray<string> | undefined
}

export interface DraftEvidenceTarget {
  readonly edits: ReadonlyArray<EvidenceReference>
  readonly fileOperations?: ReadonlyArray<EvidenceReference> | undefined
  readonly evidence: ReadonlyArray<EvidenceRecord>
}

export interface MissingEvidence {
  readonly kind?: string | undefined
  readonly facts?: EvidenceRecord["facts"] | undefined
}

/** Merge declared evidence and synthesize records for every referenced ID. */
export const finalizeDraftEvidence = <A extends DraftEvidenceTarget>(
  draft: A,
  missing: MissingEvidence = {},
): A => {
  const evidence = new Map(mergeEvidence(draft.evidence).map((record) => [record.id, record]))
  const referencedIds = [
    ...draft.edits.flatMap((edit) => edit.evidenceIds ?? []),
    ...(draft.fileOperations ?? []).flatMap((operation) => operation.evidenceIds ?? []),
  ]
  for (const id of referencedIds) {
    if (evidence.has(id)) continue
    evidence.set(id, {
      id,
      kind: missing.kind ?? "draft-operation",
      facts: missing.facts ?? {},
    })
  }
  return { ...draft, evidence: [...evidence.values()] }
}

/** Effect form of `finalizeDraftEvidence` for typed recipe failures. */
export const finalizeDraftEvidenceEffect = <A extends DraftEvidenceTarget>(
  draft: A,
  missing: MissingEvidence = {},
): Effect.Effect<A, DraftEvidenceConflict> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(finalizeDraftEvidence(draft, missing))
    } catch (cause) {
      return cause instanceof DraftEvidenceConflict ? Effect.fail(cause) : Effect.die(cause)
    }
  })
