/**
 * Verification domain — diagnostics, rules, and verified plans.
 *
 * Preview materializes a plan's exact proposed bytes without writing.
 * Verification evaluates the plan against fresh, isolated compiler
 * authorities — baseline and proposed — computes the diagnostic delta,
 * evaluates every Plan Policy, replays the recipe when idempotence is
 * declared, and returns the process-local Verified Plan: the only input
 * Application accepts. Neither stage writes project files.
 */
import { path as Path, layer as nodeLayer } from "../platform/node.ts"
import { Data, Effect, Predicate, Schema } from "effect"
import { nativeRequest, type NativeCompilerError } from "../Compiler/Service.ts"
import { canonicalJson, type Json, type TransformationPlan } from "../Plan/index.ts"
import {
  type PlanPreview,
  type PolicyResult,
  previewPlan,
  type StalePlanError,
  type VerificationObservation,
  VerificationFailure,
  type VerifiedPlan,
  verifyPreview,
} from "./Engine.ts"
import {
  computeDiagnosticDiff,
  type DiagnosticDiff,
  type DiagnosticRecord,
  type PolicyEvaluationContext,
} from "../Policy/index.ts"
import { TOOLCHAIN, type Recipe } from "../Recipe/index.ts"
import {
  Workspace,
  WorkspaceSnapshot,
  type ProjectNotInSnapshot,
  type SnapshotExpired,
} from "../Workspace/index.ts"
import type { VirtualFsSnapshot } from "../VirtualFs/index.ts"

export { StalePlanError, VerificationFailure } from "./Engine.ts"

/** The supplied recipe is not the recipe that authored the durable plan. */
export class RecipeMismatch extends Data.TaggedError("RecipeMismatch")<{
  readonly planId: string
  readonly expected: {
    readonly name: string
    readonly version: string
    readonly implementationHash: string
  }
  readonly actual: {
    readonly name: string
    readonly version: string
    readonly implementationHash: string
  }
}> {}

/** The supplied recipe input does not match the canonical input in the plan. */
export class RecipeInputMismatch extends Data.TaggedError("RecipeInputMismatch")<{
  readonly planId: string
  readonly expected: Json
  readonly actual: Json
}> {}

/** The running toolchain is not the one that authored the durable plan. */
export class ToolchainMismatch extends Data.TaggedError("ToolchainMismatch")<{
  readonly planId: string
  readonly expected: TransformationPlan["toolchain"]
  readonly actual: TransformationPlan["toolchain"]
}> {}

/** The supplied recipe's durable policies differ from those in the plan. */
export class PolicyMismatch extends Data.TaggedError("PolicyMismatch")<{
  readonly planId: string
  readonly expected: TransformationPlan["policies"]
  readonly actual: TransformationPlan["policies"]
}> {}

export type {
  FilePreview,
  FileState,
  PlanPreview,
  PolicyResult,
  VerificationReceipt,
  VerifiedPlan,
} from "./Engine.ts"

export type { DiagnosticDiff, DiagnosticRecord, PolicyEvaluationContext } from "../Policy/index.ts"

interface NativeDiagnosticMessage {
  readonly messageText: string
}

interface NativeDiagnostic {
  readonly code: number
  readonly messageText?: string | NativeDiagnosticMessage
  readonly category: number
  readonly file?: { readonly fileName?: string }
  readonly start?: number
  readonly length?: number
}

const diagnosticMessageText = (
  messageText: string | NativeDiagnosticMessage | undefined,
): string => {
  if (Predicate.isString(messageText)) return messageText
  return messageText?.messageText ?? "Unknown diagnostic"
}

const absoluteTarget = (
  workspaceRoot: string,
  plan: TransformationPlan,
  projectId: string,
  fileName: string,
): string => {
  const project = plan.projects.find((candidate) => candidate.id === projectId)
  if (project === undefined) {
    // Finalization guarantees every edit references a known project.
    throw new Error(`Unknown project ID: ${projectId}`)
  }
  return Path.resolve(workspaceRoot, Path.dirname(project.configFileName), fileName)
}

/**
 * Materialize the plan's exact proposed bytes. Revalidates every fingerprint
 * and guarded range against the current workspace; a mismatch is a StalePlan.
 * Never writes.
 */
export const of = (
  plan: TransformationPlan,
): Effect.Effect<PlanPreview, StalePlanError | VerificationFailure, Workspace> =>
  Workspace.use((workspace) => previewPlan(plan, workspace.root).pipe(Effect.provide(nodeLayer)))

const asJsonValue = (value: unknown): Json => value as Json

const canonicalInput = <Input, E, R>(
  recipe: Recipe<Input, E, R>,
  input: Input,
  planId: string,
  expected: Json,
): Effect.Effect<{ readonly value: Input; readonly json: Json }, RecipeInputMismatch> =>
  Effect.gen(function* () {
    let validated = input
    if (recipe.schema !== undefined) {
      const decode = Schema.decodeUnknownEffect(recipe.schema) as (
        value: unknown,
      ) => Effect.Effect<Input, Schema.SchemaError>
      validated = yield* decode(input)
      // Encode after decoding. This mirrors Recipe.run's validation and gives
      // schemas with transforms/defaults the same canonical representation used
      // in plan.recipe.options.
      const encode = Schema.encodeUnknownEffect(recipe.schema) as (
        value: Input,
      ) => Effect.Effect<unknown, Schema.SchemaError>
      const encoded = yield* encode(validated)
      return { value: validated, json: asJsonValue(encoded ?? null) }
    }
    return { value: validated, json: asJsonValue(validated ?? null) }
  }).pipe(Effect.mapError(() => new RecipeInputMismatch({ planId, expected, actual: null })))

const validateRecipeForPlan = <Input, E, R>(
  plan: TransformationPlan,
  recipe: Recipe<Input, E, R>,
  input: Input,
): Effect.Effect<
  Input,
  RecipeMismatch | RecipeInputMismatch | PolicyMismatch | ToolchainMismatch
> =>
  Effect.gen(function* () {
    const expectedIdentity = {
      name: plan.recipe.name,
      version: plan.recipe.version,
      implementationHash: plan.recipe.implementationHash,
    }
    const actualIdentity = {
      name: recipe.name,
      version: recipe.version,
      implementationHash: recipe.implementationHash,
    }
    if (
      expectedIdentity.name !== actualIdentity.name ||
      expectedIdentity.version !== actualIdentity.version ||
      expectedIdentity.implementationHash !== actualIdentity.implementationHash
    ) {
      return yield* new RecipeMismatch({
        planId: plan.planId,
        expected: expectedIdentity,
        actual: actualIdentity,
      })
    }

    const encoded = yield* canonicalInput(recipe, input, plan.planId, plan.recipe.options)
    if (canonicalJson(encoded.json) !== canonicalJson(plan.recipe.options)) {
      return yield* new RecipeInputMismatch({
        planId: plan.planId,
        expected: plan.recipe.options,
        actual: encoded.json,
      })
    }

    if (canonicalJson(asJsonValue(recipe.policies)) !== canonicalJson(asJsonValue(plan.policies))) {
      return yield* new PolicyMismatch({
        planId: plan.planId,
        expected: plan.policies,
        actual: recipe.policies,
      })
    }

    if (canonicalJson(asJsonValue(TOOLCHAIN)) !== canonicalJson(asJsonValue(plan.toolchain))) {
      return yield* new ToolchainMismatch({
        planId: plan.planId,
        expected: plan.toolchain,
        actual: TOOLCHAIN,
      })
    }
    return encoded.value
  })

const collectDiagnostics = Effect.gen(function* () {
  const snapshot = yield* WorkspaceSnapshot
  const allDiagnostics: Array<DiagnosticRecord> = []

  for (const configured of snapshot.projects) {
    const project = yield* snapshot.project(configured)
    const diagnosticList = yield* project.unsafeNative((nativeProject) =>
      nativeRequest<ReadonlyArray<NativeDiagnostic>>("getSemanticDiagnostics", () =>
        nativeProject.program.getSemanticDiagnostics(),
      ),
    )
    for (const d of diagnosticList) {
      const message = diagnosticMessageText(d.messageText)
      allDiagnostics.push({
        code: d.code,
        message,
        category:
          d.category === 0
            ? "warning"
            : d.category === 2
              ? "suggestion"
              : d.category === 3
                ? "message"
                : "error",
        fileName: d.file?.fileName,
        start: d.start,
        length: d.length,
      })
    }
  }
  return allDiagnostics
})

/**
 * Verify a plan against its snapshot and policies using fresh compiler
 * authorities: one over the real inputs (baseline diagnostics) and one over
 * the proposed virtual state (proposed diagnostics plus, when the plan
 * declares idempotence, a replay of the recipe that must yield zero edits).
 * Returns the process-local Verified Plan on success.
 */
export const verify = <Input, E, R>(
  plan: TransformationPlan,
  recipe: Recipe<Input, E, R>,
  input: Input,
): Effect.Effect<
  VerifiedPlan & { readonly diagnosticDiff: DiagnosticDiff },
  | E
  | VerificationFailure
  | StalePlanError
  | RecipeMismatch
  | RecipeInputMismatch
  | PolicyMismatch
  | ToolchainMismatch
  | NativeCompilerError
  | ProjectNotInSnapshot
  | SnapshotExpired,
  Workspace | Exclude<R, WorkspaceSnapshot>
> =>
  Effect.gen(function* () {
    const workspace = yield* Workspace
    const validatedInput = yield* validateRecipeForPlan(plan, recipe, input)
    const proposed = yield* of(plan)

    const files = new Map<string, string>()
    const created = new Set<string>()
    const deleted = new Set<string>()
    for (const file of proposed.files) {
      const target = absoluteTarget(workspace.root, plan, file.projectId, file.fileName)
      if (file.after.exists) {
        files.set(target, file.after.text)
        if (!file.before.exists) created.add(target)
      } else {
        deleted.add(target)
      }
    }
    const overlay: VirtualFsSnapshot = { files, created, deleted }

    const baselineDiagnostics = yield* workspace.withIsolatedSnapshot(
      { files: new Map(), created: new Set(), deleted: new Set() },
      collectDiagnostics,
    )

    const proposedRun = yield* workspace.withIsolatedSnapshot(
      overlay,
      Effect.gen(function* () {
        const diagnostics = yield* collectDiagnostics
        if (plan.policies.idempotence !== "required") {
          // SAFETY: no replay is requested, so this optional count is absent by construction.
          return { diagnostics, replayChanges: undefined }
        }
        const replay = yield* recipe.run(validatedInput)
        // SAFETY: both collections are normalized recipe output. File
        // operations are changes just like text edits for idempotence.
        return {
          diagnostics,
          replayChanges: replay.edits.length + (replay.fileOperations?.length ?? 0),
        }
      }),
    )

    const diagnosticDiff = computeDiagnosticDiff(baselineDiagnostics, proposedRun.diagnostics)

    const matches = plan.measurements?.matches
    const { min, max } = plan.policies.matchCount
    if ((min !== undefined || max !== undefined) && matches === undefined) {
      return yield* new VerificationFailure({
        planId: plan.planId,
        policy: "matches",
        detail: "Plan carries no primary-run match measurement",
      })
    }

    const policyResults: Array<PolicyResult> = []
    if (plan.policies.matchCount.min !== undefined || plan.policies.matchCount.max !== undefined) {
      policyResults.push({ name: "match-count", passed: true })
    }
    if (plan.policies.maxAffectedFiles !== undefined) {
      policyResults.push({ name: "affected-files", passed: true })
    }
    const introducedErrors = diagnosticDiff.introduced.filter(
      (diagnostic) => diagnostic.category === "error",
    )
    if (plan.policies.diagnostics === "no-new-errors") {
      policyResults.push({ name: "no-new-errors", passed: introducedErrors.length === 0 })
    } else {
      policyResults.push({ name: "diagnostic-diff", passed: true })
    }
    if (plan.policies.idempotence === "required") {
      policyResults.push({ name: "idempotence", passed: proposedRun.replayChanges === 0 })
    }

    const context: PolicyEvaluationContext = {
      actualMatches: matches ?? 0,
      affectedFiles: proposed.files.length,
      diagnosticDiff,
      replayEdits: proposedRun.replayChanges,
    }

    if (recipe.rules.length > 0) {
      for (const rule of recipe.rules) {
        const result = rule.evaluate(context)
        if (result === true) {
          policyResults.push({ name: rule.name, passed: true })
        } else {
          const detail = result === false ? `Policy rule '${rule.name}' failed` : result
          policyResults.push({ name: rule.name, passed: false, detail })
          return yield* new VerificationFailure({
            planId: plan.planId,
            policy: "diagnostics",
            detail,
            diagnostics: diagnosticDiff.introduced,
          })
        }
      }
    }

    const baselineErrorCount = baselineDiagnostics.filter((d) => d.category === "error").length
    const proposedErrorCount = proposedRun.diagnostics.filter((d) => d.category === "error").length

    const observation: VerificationObservation =
      proposedRun.replayChanges === undefined
        ? {
            actualMatches: matches ?? 0,
            baselineErrorCount,
            proposedErrorCount,
            diagnosticDiff,
            policyResults,
          }
        : {
            actualMatches: matches ?? 0,
            baselineErrorCount,
            proposedErrorCount,
            diagnosticDiff,
            policyResults,
            secondPlanChangeCount: proposedRun.replayChanges,
          }

    const verified = yield* verifyPreview(plan, proposed, observation)

    return Object.assign(verified, { diagnosticDiff })
  })
