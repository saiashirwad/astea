/** Verification and application service engine. */
import { Data, Effect, FileSystem, Path } from "effect"
import { applyFileEdits, textHash } from "../Edit/index.ts"
import type { TransformationPlan } from "../Plan/index.ts"

export class StalePlanError extends Data.TaggedError("StalePlanError")<{
  readonly planId: string
  readonly projectId: string
  readonly fileName: string
}> {}

export class VerificationFailure extends Data.TaggedError("VerificationFailure")<{
  readonly planId: string
  readonly policy: "edits" | "matches" | "affected-files" | "diagnostics" | "idempotence"
  readonly detail: string
}> {}

export interface FilePreview {
  readonly projectId: string
  readonly fileName: string
  readonly beforeHash: string
  readonly afterHash: string
  readonly beforeText: string
  readonly afterText: string
}

export interface PlanPreview {
  readonly planId: string
  readonly snapshotHash: string
  readonly files: ReadonlyArray<FilePreview>
}

export interface VerificationObservation {
  readonly actualMatches: number
  readonly baselineErrorCount: number
  readonly proposedErrorCount: number
  readonly secondPlanEditCount?: number
  readonly policyResults?: ReadonlyArray<PolicyResult>
}

export interface PolicyResult {
  readonly name: string
  readonly passed: boolean
  readonly detail?: string
}

export interface VerificationReceipt {
  readonly planId: string
  readonly snapshotHash: string
  readonly affectedFiles: number
  readonly actualMatches: number
  readonly baselineErrorCount: number
  readonly proposedErrorCount: number
  readonly diagnosticDelta: number
  readonly idempotenceChecked: boolean
  readonly policyResults: ReadonlyArray<PolicyResult>
}

// SAFETY: nominal brand symbol creation
const VerifiedPlanTypeId: unique symbol = Symbol.for("@safemods/internal/VerifiedPlan") as never

export interface VerifiedPlan {
  readonly [VerifiedPlanTypeId]: typeof VerifiedPlanTypeId
  readonly plan: TransformationPlan
  readonly preview: PlanPreview
  readonly receipt: VerificationReceipt
}

const absoluteFileName = (
  plan: TransformationPlan,
  workspaceRoot: string,
  projectId: string,
  fileName: string,
): Effect.Effect<string, never, Path.Path> => Effect.gen(function*() {
  const path = yield* Path.Path
  const project = plan.projects.find((candidate) => candidate.id === projectId)
  if (project === undefined) return yield* Effect.die(new Error(`Unknown project ID: ${projectId}`))
  return path.resolve(workspaceRoot, path.dirname(project.configFileName), fileName)
})

export const previewPlan = (
  plan: TransformationPlan,
  workspaceRoot: string,
): Effect.Effect<PlanPreview, StalePlanError | VerificationFailure, FileSystem.FileSystem | Path.Path> => Effect.gen(function*() {
  const sourceTexts = new Map<string, string>()
  for (const source of plan.sources) {
    const absolute = yield* absoluteFileName(plan, workspaceRoot, source.projectId, source.fileName)
    const content = yield* FileSystem.FileSystem.use((fs) => fs.readFileString(absolute)).pipe(Effect.mapError(() => new StalePlanError({
        planId: plan.planId,
        projectId: source.projectId,
        fileName: source.fileName,
      })))
    if (textHash(content) !== source.hash) {
      return yield* new StalePlanError({
        planId: plan.planId,
        projectId: source.projectId,
        fileName: source.fileName,
      })
    }
    sourceTexts.set(`${source.projectId}\0${source.fileName}`, content)
  }

  for (const op of plan.fileOperations ?? []) {
    if (op.kind === "create") {
      sourceTexts.set(`${op.projectId}\0${op.path}`, op.content ?? "")
    } else if (op.kind === "move" && op.toPath !== undefined) {
      sourceTexts.set(`${op.projectId}\0${op.toPath}`, op.content ?? sourceTexts.get(`${op.projectId}\0${op.path}`) ?? "")
    }
  }

  const groups = Map.groupBy(plan.edits, (edit) => `${edit.projectId}\0${edit.fileName}`)
  const files: Array<FilePreview> = []
  for (const [key, edits] of groups) {
    const beforeText = sourceTexts.get(key)
    if (beforeText === undefined) {
      return yield* new VerificationFailure({
        planId: plan.planId,
        policy: "edits",
        detail: `Missing source for ${key}`,
      })
    }
    const afterText = yield* applyFileEdits(beforeText, edits).pipe(
      Effect.mapError((error) => new VerificationFailure({
        planId: plan.planId,
        policy: "edits",
        detail: error._tag,
      })),
    )
    const first = edits[0]!
    files.push({
      projectId: first.projectId,
      fileName: first.fileName,
      beforeHash: textHash(beforeText),
      afterHash: textHash(afterText),
      beforeText,
      afterText,
    })
  }

  if (plan.fileOperations !== undefined) {
    for (const op of plan.fileOperations) {
      if (op.kind === "create") {
        if (files.some((file) => file.projectId === op.projectId && file.fileName === op.path)) continue
        const content = op.content ?? ""
        files.push({
          projectId: op.projectId,
          fileName: op.path,
          beforeHash: textHash(""),
          afterHash: textHash(content),
          beforeText: "",
          afterText: content,
        })
      } else if (op.kind === "delete") {
        const beforeText = sourceTexts.get(`${op.projectId}\0${op.path}`) ?? ""
        files.push({
          projectId: op.projectId,
          fileName: op.path,
          beforeHash: textHash(beforeText),
          afterHash: textHash(""),
          beforeText,
          afterText: "",
        })
      } else if (op.kind === "move" && op.toPath !== undefined) {
        const beforeText = sourceTexts.get(`${op.projectId}\0${op.path}`) ?? ""
        const content = op.content ?? beforeText
        if (!files.some((file) => file.projectId === op.projectId && file.fileName === op.path)) {
          files.push({
            projectId: op.projectId,
            fileName: op.path,
            beforeHash: textHash(beforeText),
            afterHash: textHash(""),
            beforeText,
            afterText: "",
          })
        }
        if (files.some((file) => file.projectId === op.projectId && file.fileName === op.toPath)) continue
        files.push({
          projectId: op.projectId,
          fileName: op.toPath,
          beforeHash: textHash(""),
          afterHash: textHash(content),
          beforeText: "",
          afterText: content,
        })
      }
    }
  }

  files.sort((left, right) =>
    left.projectId.localeCompare(right.projectId) || left.fileName.localeCompare(right.fileName))
  return { planId: plan.planId, snapshotHash: plan.snapshotHash, files }
})

export const verifyPreview = (
  plan: TransformationPlan,
  preview: PlanPreview,
  observation: VerificationObservation,
): Effect.Effect<VerifiedPlan, VerificationFailure> => Effect.gen(function*() {
  const { min, max } = plan.policies.matchCount
  if ((min !== undefined && observation.actualMatches < min) ||
      (max !== undefined && observation.actualMatches > max)) {
    return yield* new VerificationFailure({
      planId: plan.planId,
      policy: "matches",
      detail: `Observed ${observation.actualMatches}`,
    })
  }
  if (plan.policies.maxAffectedFiles !== undefined && preview.files.length > plan.policies.maxAffectedFiles) {
    return yield* new VerificationFailure({
      planId: plan.planId,
      policy: "affected-files",
      detail: `Observed ${preview.files.length}`,
    })
  }
  if (
    plan.policies.diagnostics === "no-new-errors" &&
    observation.proposedErrorCount > observation.baselineErrorCount
  ) {
    return yield* new VerificationFailure({
      planId: plan.planId,
      policy: "diagnostics",
      detail: `${observation.baselineErrorCount} -> ${observation.proposedErrorCount}`,
    })
  }
  if (plan.policies.idempotence === "required" && observation.secondPlanEditCount !== 0) {
    return yield* new VerificationFailure({
      planId: plan.planId,
      policy: "idempotence",
      detail: "Second recipe run was not empty",
    })
  }

  const receipt: VerificationReceipt = {
    planId: plan.planId,
    snapshotHash: plan.snapshotHash,
    affectedFiles: preview.files.length,
    actualMatches: observation.actualMatches,
    baselineErrorCount: observation.baselineErrorCount,
    proposedErrorCount: observation.proposedErrorCount,
    diagnosticDelta: observation.proposedErrorCount - observation.baselineErrorCount,
    idempotenceChecked: plan.policies.idempotence === "required",
    policyResults: observation.policyResults ?? [],
  }
  return { [VerifiedPlanTypeId]: VerifiedPlanTypeId, plan, preview, receipt }
})

// Compatibility exports; application behavior lives in the Application/Node domains.
export {
  ApplicationFailure,
  ApplicationIndeterminate,
  PlanApplication,
} from "../Application/Model.ts"
export type { ApplicationReceipt, PlanApplicationService } from "../Application/Model.ts"
