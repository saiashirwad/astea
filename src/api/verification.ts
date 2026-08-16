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
import * as Path from "node:path"
import { Effect } from "effect"
import { nativeRequest, type NativeCompilerError } from "../prototype/native-compiler.ts"
import type { TransformationPlan } from "../prototype/plan.ts"
import {
  type PlanPreview,
  type PolicyResult,
  previewPlan,
  StalePlanError,
  VerificationFailure,
  type VerifiedPlan,
  verifyPreview,
} from "../prototype/verification.ts"
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
} from "./workspace.ts"

export {
  StalePlanError,
  VerificationFailure,
} from "../prototype/verification.ts"

export type {
  ApplicationReceipt,
  FilePreview,
  PlanPreview,
  VerificationReceipt,
  VerifiedPlan,
} from "../prototype/verification.ts"

export type { DiagnosticDiff, DiagnosticRecord, PolicyEvaluationContext } from "./policy.ts"

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
  Workspace.use((workspace) => previewPlan(plan, workspace.root))

export const Preview = {
  of: preview,
}

const collectDiagnostics = Effect.gen(function*() {
  const snapshot = yield* WorkspaceSnapshot
  const allDiagnostics: Array<DiagnosticRecord> = []

  for (const configured of snapshot.projects) {
    const project = yield* snapshot.project(configured)
    const diags = yield* project.unsafeNative((nativeProject) =>
      nativeRequest(
        "getSemanticDiagnostics",
        () => nativeProject.program.getSemanticDiagnostics(),
      )
    )
    // SAFETY: TypeScript compiler native diagnostics return collection of diagnostic objects
    const diagnosticList = diags as unknown as ReadonlyArray<{
      code: number
      messageText: string | { messageText: string }
      category: number
      file?: { fileName?: string }
      start?: number
      length?: number
    }>
    for (const d of diagnosticList) {
      const message = typeof d.messageText === "string"
        ? d.messageText
        : d.messageText?.messageText ?? "Unknown diagnostic"
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
          return { diagnostics, replayEdits: undefined }
        }
        const replay = yield* recipe.run(input)
        return { diagnostics, replayEdits: replay.edits.length }
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

    const policyResults: Array<{ readonly name: string; readonly passed: boolean; readonly detail?: string }> = []
    if (plan.policies.matchCount.min !== undefined || plan.policies.matchCount.max !== undefined) {
      policyResults.push({ name: "match-count", passed: true })
    }
    if (plan.policies.maxAffectedFiles !== undefined) {
      policyResults.push({ name: "affected-files", passed: true })
    }
    const introducedErrors = diagnosticDiff.introduced.filter((diagnostic) => diagnostic.category === "error")
    policyResults.push(plan.policies.diagnostics === "no-new-errors"
      ? { name: "no-new-errors", passed: introducedErrors.length === 0 }
      : { name: "diagnostic-diff", passed: true })
    if (plan.policies.idempotence === "required") {
      policyResults.push({ name: "idempotence", passed: proposedRun.replayEdits === 0 })
    }

    // Evaluate custom policy rules
    const context: PolicyEvaluationContext = {
      actualMatches: matches ?? 0,
      affectedFiles: proposed.files.length,
      diagnosticDiff,
      replayEdits: proposedRun.replayEdits,
    }

    if (recipe.policies.rules !== undefined) {
      for (const rule of recipe.policies.rules) {
        const result = rule.evaluate(context)
        const passed = result === true
        policyResults.push({
          name: rule.name,
          passed,
          ...(typeof result === "string" ? { detail: result } : {}),
        })
        if (!passed) {
          return yield* new VerificationFailure({
            planId: plan.planId,
            policy: "diagnostics",
            detail: typeof result === "string" ? result : `Policy rule '${rule.name}' failed`,
          })
        }
      }
    }

    const baselineErrorCount = baselineDiagnostics.filter((d) => d.category === "error").length
    const proposedErrorCount = proposedRun.diagnostics.filter((d) => d.category === "error").length

    const observation: {
      actualMatches: number
      baselineErrorCount: number
      proposedErrorCount: number
      secondPlanEditCount?: number
      policyResults?: ReadonlyArray<PolicyResult>
    } = {
      actualMatches: matches ?? 0,
      baselineErrorCount,
      proposedErrorCount,
      policyResults,
    }
    if (proposedRun.replayEdits !== undefined) {
      observation.secondPlanEditCount = proposedRun.replayEdits
    }

    const verified = yield* verifyPreview(plan, proposed, observation)

    return Object.assign(verified, { diagnosticDiff })
  })

export const Verification = {
  verify,
}
