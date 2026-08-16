/**
 * Candidate public API — Preview and Verification.
 *
 * Preview materializes a plan's exact proposed bytes without writing.
 * Verification evaluates the plan against fresh, isolated compiler
 * authorities — baseline and proposed — computes the diagnostic delta,
 * evaluates every Plan Policy, replays the recipe when idempotence is
 * declared, and returns the process-local Verified Plan: the only input
 * Application accepts. Neither stage writes project files.
 */
import { path as Path } from "../platform/node.ts"
import { Effect, Predicate } from "effect"
import { layer as nodeLayer } from "../platform/node.ts"
import { nativeRequest, type NativeCompilerError } from "../internal/native-compiler.ts"
import type { TransformationPlan } from "../internal/plan.ts"
import {
  type PlanPreview,
  type PolicyResult,
  previewPlan,
  StalePlanError,
  type VerificationObservation,
  VerificationFailure,
  type VerifiedPlan,
  verifyPreview,
} from "../internal/verification.ts"
import {
  computeDiagnosticDiff,
  type DiagnosticDiff,
  type DiagnosticRecord,
  type PolicyEvaluationContext,
} from "./policy.ts"
import type { Recipe } from "./recipe.ts"
import {
  Workspace,
  WorkspaceSnapshot,
  type ProjectNotInSnapshot,
  type SnapshotExpired,
} from "../Workspace/index.ts"

export {
  StalePlanError,
  VerificationFailure,
} from "../internal/verification.ts"

export type {
  ApplicationReceipt,
  FilePreview,
  PlanPreview,
  VerificationReceipt,
  VerifiedPlan,
} from "../internal/verification.ts"

export type { DiagnosticDiff, DiagnosticRecord, PolicyEvaluationContext } from "./policy.ts"

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

const diagnosticMessageText = (messageText: string | NativeDiagnosticMessage | undefined): string => {
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
const preview = (
  plan: TransformationPlan,
): Effect.Effect<PlanPreview, StalePlanError | VerificationFailure, Workspace> =>
  Workspace.use((workspace) => previewPlan(plan, workspace.root).pipe(Effect.provide(nodeLayer)))

export const Preview = {
  of: preview,
}

const collectDiagnostics = Effect.gen(function*() {
  const snapshot = yield* WorkspaceSnapshot
  const allDiagnostics: Array<DiagnosticRecord> = []

  for (const configured of snapshot.projects) {
    const project = yield* snapshot.project(configured)
    const diagnosticList = yield* project.unsafeNative((nativeProject) =>
      nativeRequest<ReadonlyArray<NativeDiagnostic>>(
        "getSemanticDiagnostics",
        () => nativeProject.program.getSemanticDiagnostics(),
      )
    )
    for (const d of diagnosticList) {
      const message = diagnosticMessageText(d.messageText)
      allDiagnostics.push({
        code: d.code,
        message,
        category: d.category === 0
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
const verify = <Input, E, R>(
  plan: TransformationPlan,
  recipe: Recipe<Input, E, R>,
  input: Input,
): Effect.Effect<
  VerifiedPlan & { readonly diagnosticDiff: DiagnosticDiff },
  | E
  | VerificationFailure
  | StalePlanError
  | NativeCompilerError
  | ProjectNotInSnapshot
  | SnapshotExpired,
  Workspace | Exclude<R, WorkspaceSnapshot>
> =>
  Effect.gen(function*() {
    const workspace = yield* Workspace
    const proposed = yield* preview(plan)

    const overlay: Record<string, string> = {}
    for (const file of proposed.files) {
      overlay[absoluteTarget(workspace.root, plan, file.projectId, file.fileName)] = file.afterText
    }

    const baselineDiagnostics = yield* workspace.withIsolatedSnapshot({}, collectDiagnostics)

    const proposedRun = yield* workspace.withIsolatedSnapshot(
      overlay,
      Effect.gen(function*() {
        const diagnostics = yield* collectDiagnostics
        if (plan.policies.idempotence !== "required") {
          // SAFETY: no replay is requested, so this optional count is absent by construction.
          return { diagnostics, replayEdits: undefined as number | undefined }
        }
        const replay = yield* recipe.run(input)
        // SAFETY: replay.edits is the normalized edit list produced by the recipe.
        return { diagnostics, replayEdits: replay.edits.length as number | undefined }
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
    const introducedErrors = diagnosticDiff.introduced.filter((diagnostic) => diagnostic.category === "error")
    if (plan.policies.diagnostics === "no-new-errors") {
      policyResults.push({ name: "no-new-errors", passed: introducedErrors.length === 0 })
    } else {
      policyResults.push({ name: "diagnostic-diff", passed: true })
    }
    if (plan.policies.idempotence === "required") {
      policyResults.push({ name: "idempotence", passed: proposedRun.replayEdits === 0 })
    }

    const context: PolicyEvaluationContext = {
      actualMatches: matches ?? 0,
      affectedFiles: proposed.files.length,
      diagnosticDiff,
      replayEdits: proposedRun.replayEdits,
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
          })
        }
      }
    }

    const baselineErrorCount = baselineDiagnostics.filter((d) => d.category === "error").length
    const proposedErrorCount = proposedRun.diagnostics.filter((d) => d.category === "error").length

    const observation: VerificationObservation = proposedRun.replayEdits === undefined
      ? {
        actualMatches: matches ?? 0,
        baselineErrorCount,
        proposedErrorCount,
        policyResults,
      }
      : {
        actualMatches: matches ?? 0,
        baselineErrorCount,
        proposedErrorCount,
        policyResults,
        secondPlanEditCount: proposedRun.replayEdits,
      }

    const verified = yield* verifyPreview(plan, proposed, observation)

    return Object.assign(verified, { diagnosticDiff })
  })

export const Verification = {
  verify,
}
