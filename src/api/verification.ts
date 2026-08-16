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
    for (const d of diags as ReadonlyArray<any>) {
      allDiagnostics.push({
        code: d.code,
        message: typeof d.messageText === "string"
          ? d.messageText
          : (d.messageText?.messageText ?? String(d.messageText)),
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

    const proposedRun = yield* workspace.withIsolatedSnapshot(overlay, Effect.gen(function*() {
      const diagnostics = yield* collectDiagnostics
      if (plan.policies.idempotence !== "required") {
        return { diagnostics, replayEdits: undefined as number | undefined }
      }
      const replay = yield* recipe.run(input)
      return { diagnostics, replayEdits: replay.edits.length as number | undefined }
    }))

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
        if (result !== true) {
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

    const verified = yield* verifyPreview(plan, proposed, {
      actualMatches: matches ?? 0,
      baselineErrorCount,
      proposedErrorCount,
      ...(proposedRun.replayEdits === undefined ? {} : { secondPlanEditCount: proposedRun.replayEdits }),
    })

    return Object.assign(verified, { diagnosticDiff })
  })

export const Verification = {
  verify,
}
