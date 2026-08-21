export type { EvidenceFact, EvidenceRecord, Json, QueryEvidence } from "./Evidence.ts"
export {
  DraftEvidenceConflict,
  finalizeDraftEvidence,
  finalizeDraftEvidenceEffect,
  mergeEvidence,
  mergeEvidenceEffect,
} from "./Finalize.ts"
export type { DraftEvidenceTarget, MissingEvidence } from "./Finalize.ts"
