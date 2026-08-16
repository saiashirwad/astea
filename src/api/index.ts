/**
 * teatime — Effect-native TypeScript 7 project transformations.
 *
 * The pipeline is the API:
 *
 *   Query → Draft → Recipe.run (durable Plan) → Preview → Verification → Application
 *
 * Services exist only at authority seams: `Workspace` (read/plan/verify
 * authority), `WorkspaceSnapshot` (region capability), and `PlanApplication`
 * (write authority). Everything else is a plain value or an
 * Effect-returning function.
 */
export {
  Application,
  layerNode as planApplicationLayerNode,
  PlanApplication,
} from "./application.ts"
export type { ApplicationReceipt } from "./application.ts"
export { Draft } from "./draft.ts"
export type { Draft as DraftPlan, EditRangeOptions, ProposedEdit, Replacement } from "./draft.ts"
export { Pattern } from "./pattern.ts"
export type { PatternMatchResult, PatternMismatch, PatternResult } from "./pattern.ts"
export { Plan, PlanBuildError, PlanDecodeError } from "./plan.ts"
export type {
  EvidenceRecord,
  Json,
  PlanMeasurements,
  PlanPolicies,
  ProjectEvidence,
  SourceFingerprint,
  TextEdit,
  TransformationPlan,
} from "./plan.ts"
export { computeDiagnosticDiff, Policy } from "./policy.ts"
export type {
  CustomPolicyRule,
  DiagnosticDiff,
  DiagnosticRecord,
  PolicyEvaluationContext,
} from "./policy.ts"
export { Criterion, Query, QueryContractError } from "./query.ts"
export type { EvidenceFact, QueryEvidence, Selection } from "./query.ts"
export { Recipe, RecipeInputError, TOOLCHAIN } from "./recipe.ts"
export type { RecipeDefinition } from "./recipe.ts"
export { Preview, StalePlanError, Verification, VerificationFailure } from "./verification.ts"
export type { FilePreview, PlanPreview, VerificationReceipt, VerifiedPlan } from "./verification.ts"
export {
  computeOverlayMap,
  ConfiguredProject,
  DuplicateConfiguredProject,
  FileNotFound,
  overlay,
  ProjectNotInSnapshot,
  SnapshotExpired,
  SymbolNotFound,
  Workspace,
  WorkspaceSnapshot,
} from "./workspace.ts"
export type {
  NativeCompilerError,
  ProjectSnapshot,
  ProjectSnapshotError,
  SnapshotTransition,
  WorkspaceChanges,
  WorkspaceDefinition,
  WorkspaceService,
  WorkspaceSnapshotService,
} from "./workspace.ts"
