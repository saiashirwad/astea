/**
 * safemods — Effect-native TypeScript 7 project transformations.
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
  computeUnifiedDiff,
  renderDiagnosticDiff,
  renderFilePreview,
  renderPlanPreview,
} from "../cli/diff.ts"
export type { DiffOptions } from "../cli/diff.ts"
export { recipeToAgentTool } from "../cli/tool.ts"
export type { AgentTool } from "../cli/tool.ts"
export {
  Application,
  layerNode as planApplicationLayerNode,
  PlanApplication,
} from "./application.ts"
export type { ApplicationReceipt } from "./application.ts"
export { Draft } from "./draft.ts"
export type { Draft as DraftPlan, EditRangeOptions, ProposedEdit, Replacement } from "./draft.ts"
export {
  awaitExpression,
  classDeclaration,
  doStatement,
  forInStatement,
  forOfStatement,
  forStatement,
  functionDeclaration,
  ifStatement,
  isStringLike,
  loop,
  Pattern,
  returnStatement,
  stringLike,
  tryStatement,
  variableDeclaration,
  variableStatement,
  whileStatement,
} from "./pattern.ts"
export type {
  AwaitExpressionPatternOptions,
  ClassDeclarationPatternOptions,
  FunctionDeclarationPatternOptions,
  IfStatementPatternOptions,
  LoopPatternOptions,
  LoopStatement,
  PatternMatchResult,
  PatternMismatch,
  PatternResult,
  ReturnStatementPatternOptions,
  StringLike,
  TryStatementPatternOptions,
  VariableDeclarationPatternOptions,
  VariableStatementPatternOptions,
} from "./pattern.ts"
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
export {
  Criterion,
  following,
  follows,
  has,
  inside,
  precedes,
  preceding,
  Query,
  QueryContractError,
} from "./query.ts"
export type {
  EvidenceFact,
  HasOptions,
  InsideOptions,
  ProjectScope,
  QueryEvidence,
  RelationalMatcher,
  Selection,
  SiblingOptions,
} from "./query.ts"
export { Recipe, RecipeInputError, TOOLCHAIN } from "./recipe.ts"
export type { RecipeDefinition } from "./recipe.ts"
export { Preview, StalePlanError, Verification, VerificationFailure } from "./verification.ts"
export type { FilePreview, PlanPreview, VerificationReceipt, VerifiedPlan } from "./verification.ts"
export {
  computeOverlayMap,
  ConfiguredProject,
  DuplicateConfiguredProject,
  FileNotFound,
  isProjectFile,
  overlay,
  ProjectFileTypeSymbol,
  ProjectNotInSnapshot,
  SnapshotExpired,
  SymbolNotFound,
  Workspace,
  WorkspaceSnapshot,
} from "./workspace.ts"
export type {
  NativeCompilerError,
  ProjectFile,
  ProjectSnapshot,
  ProjectSnapshotError,
  SnapshotTransition,
  WorkspaceChanges,
  WorkspaceDefinition,
  WorkspaceService,
  WorkspaceSnapshotService,
} from "./workspace.ts"
