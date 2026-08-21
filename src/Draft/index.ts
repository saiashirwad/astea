/** Public Draft API assembled from focused domain modules. */
export {
  audit,
  concat,
  concatEffect,
  empty,
  insertAfter,
  insertBefore,
  isDraft,
  print,
  remove,
  replace,
  replaceEach,
  replaceWith,
} from "./Draft.ts"
export {
  DraftEvidenceConflict,
  finalizeDraftEvidence,
  finalizeDraftEvidenceEffect,
  mergeEvidence,
  mergeEvidenceEffect,
} from "../Evidence/index.ts"
export type { Draft, EditRangeOptions, ProposedEdit, Replacement } from "./Draft.ts"
export * from "./Files.ts"
export * from "./Imports.ts"
export * from "./Symbols.ts"
export * from "./Cleanup.ts"
