/** Shared recipe execution from planning through optional application. */
import { Effect, type FileSystem, type Path } from "effect"
import { apply, type ApplicationReceipt, type PlanApplication } from "../Application/index.ts"
import type { ApplicationFailure, ApplicationIndeterminate } from "../Application/Application.ts"
import type { DraftEvidenceConflict } from "../Draft/index.ts"
import type { PlanBuildError, PlanDecodeError, TransformationPlan } from "../Plan/index.ts"
import type { DiagnosticDiff } from "../Policy/index.ts"
import { run, type Recipe, type RecipeInputError } from "../Recipe/index.ts"
import {
  of,
  type PlanPreview,
  type PolicyMismatch,
  type ProjectIdentityMismatch,
  type RecipeInputMismatch,
  type RecipeMismatch,
  type StalePlanError,
  type ToolchainMismatch,
  type VerificationFailure,
  verify,
  type VerifiedPlan,
} from "../Verification/index.ts"
import type {
  ProjectNotInSnapshot,
  SnapshotExpired,
  Workspace,
  WorkspaceCompilerError,
  WorkspaceSnapshot,
} from "../Workspace/index.ts"

export type RecipeExecutionMode = "plan" | "preview" | "verify" | "apply"

type VerifiedExecutionPlan = VerifiedPlan & { readonly diagnosticDiff: DiagnosticDiff }

export interface RecipeExecutionHooks {
  readonly onPreview?: (plan: TransformationPlan, preview: PlanPreview) => Effect.Effect<void>
  readonly onVerified?: (
    plan: TransformationPlan,
    preview: PlanPreview,
    verified: VerifiedExecutionPlan,
  ) => Effect.Effect<void>
}

export interface PlanExecution {
  readonly mode: "plan"
  readonly plan: TransformationPlan
}

export interface PreviewExecution {
  readonly mode: "preview"
  readonly plan: TransformationPlan
  readonly preview: PlanPreview
}

export interface VerifiedExecution {
  readonly mode: "verify"
  readonly plan: TransformationPlan
  readonly preview: PlanPreview
  readonly verified: VerifiedExecutionPlan
}

export interface AppliedExecution {
  readonly mode: "apply"
  readonly plan: TransformationPlan
  readonly preview: PlanPreview
  readonly verified: VerifiedExecutionPlan
  readonly receipt: ApplicationReceipt
}

export type RecipeExecutionResult =
  | PlanExecution
  | PreviewExecution
  | VerifiedExecution
  | AppliedExecution

export type RecipeExecutionError<E> =
  | E
  | RecipeInputError
  | PlanBuildError
  | PlanDecodeError
  | DraftEvidenceConflict
  | WorkspaceCompilerError
  | ProjectNotInSnapshot
  | SnapshotExpired
  | StalePlanError
  | VerificationFailure
  | ProjectIdentityMismatch
  | RecipeMismatch
  | RecipeInputMismatch
  | PolicyMismatch
  | ToolchainMismatch

export type RecipeApplicationError<E> =
  | RecipeExecutionError<E>
  | ApplicationFailure
  | ApplicationIndeterminate

interface PlanExecutionOptions {
  readonly mode: "plan"
  readonly hooks?: RecipeExecutionHooks | undefined
}

interface PreviewExecutionOptions {
  readonly mode: "preview"
  readonly hooks?: RecipeExecutionHooks | undefined
}

interface VerifyExecutionOptions {
  readonly mode: "verify"
  readonly hooks?: RecipeExecutionHooks | undefined
}

interface ApplyExecutionOptions {
  readonly mode: "apply"
  readonly hooks?: RecipeExecutionHooks | undefined
}

type RecipeExecutionOptions =
  | PlanExecutionOptions
  | PreviewExecutionOptions
  | VerifyExecutionOptions
  | ApplyExecutionOptions

type RecipeRequirements<R> =
  | Workspace
  | FileSystem.FileSystem
  | Path.Path
  | Exclude<R, WorkspaceSnapshot>
type VerificationRequirements<R> = RecipeRequirements<R>
type ApplyRequirements<R> = VerificationRequirements<R> | PlanApplication

export function executeRecipe<Input, E, R>(
  recipe: Recipe<Input, E, R>,
  input: Input,
  options: PlanExecutionOptions,
): Effect.Effect<PlanExecution, RecipeExecutionError<E>, RecipeRequirements<R>>
export function executeRecipe<Input, E, R>(
  recipe: Recipe<Input, E, R>,
  input: Input,
  options: PreviewExecutionOptions,
): Effect.Effect<PreviewExecution, RecipeExecutionError<E>, VerificationRequirements<R>>
export function executeRecipe<Input, E, R>(
  recipe: Recipe<Input, E, R>,
  input: Input,
  options: VerifyExecutionOptions,
): Effect.Effect<VerifiedExecution, RecipeExecutionError<E>, VerificationRequirements<R>>
export function executeRecipe<Input, E, R>(
  recipe: Recipe<Input, E, R>,
  input: Input,
  options: ApplyExecutionOptions,
): Effect.Effect<AppliedExecution, RecipeApplicationError<E>, ApplyRequirements<R>>
export function executeRecipe<Input, E, R>(
  recipe: Recipe<Input, E, R>,
  input: Input,
  options: RecipeExecutionOptions,
) {
  return Effect.gen(function* () {
    const plan = yield* run(recipe, input)
    if (options.mode === "plan") return { mode: "plan" as const, plan }

    const preview = yield* of(plan)
    if (options.hooks?.onPreview !== undefined) {
      yield* options.hooks.onPreview(plan, preview)
    }
    if (options.mode === "preview") return { mode: "preview" as const, plan, preview }

    const verified = yield* verify(plan, recipe, input, { preview })
    if (options.hooks?.onVerified !== undefined) {
      yield* options.hooks.onVerified(plan, preview, verified)
    }
    if (options.mode === "verify") {
      return { mode: "verify" as const, plan, preview, verified }
    }

    const receipt = yield* apply(verified)
    return { mode: "apply" as const, plan, preview, verified, receipt }
  })
}
