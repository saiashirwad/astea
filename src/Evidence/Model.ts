export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

export type EvidenceFact = string | number | boolean | null

/** Deterministic facts explaining why a semantic selection qualified. */
export interface QueryEvidence {
  readonly criterion: string
  readonly facts: Readonly<Record<string, EvidenceFact>>
}

/** Durable evidence attached to a transformation plan. */
export interface EvidenceRecord {
  readonly id: string
  readonly kind: string
  readonly facts: { readonly [key: string]: Json }
}
