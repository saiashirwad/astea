/** Read-only preview/verification and separately authorized application. */
import { randomUUID } from "node:crypto"
import { Context, Data, Effect, FileSystem, Layer, Path } from "effect"
import { applyFileEdits, type TextEdit, textHash } from "./edits.ts"
import type { PlannedTextEdit, TransformationPlan } from "./plan.ts"

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

export class ApplicationFailure extends Data.TaggedError("ApplicationFailure")<{
  readonly planId: string
  readonly cause: unknown
  readonly rolledBack: boolean
}> {}

export class ApplicationIndeterminate extends Data.TaggedError("ApplicationIndeterminate")<{
  readonly planId: string
  readonly cause: unknown
  readonly rollbackCause: unknown
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
const VerifiedPlanTypeId: unique symbol = Symbol.for("@teamod/internal/VerifiedPlan") as never

export interface VerifiedPlan {
  readonly [VerifiedPlanTypeId]: typeof VerifiedPlanTypeId
  readonly plan: TransformationPlan
  readonly preview: PlanPreview
  readonly receipt: VerificationReceipt
}

export interface ApplicationReceipt {
  readonly planId: string
  readonly snapshotHash: string
  readonly outputs: ReadonlyArray<{
    readonly projectId: string
    readonly fileName: string
    readonly hash: string
  }>
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

const editForApply = (plan: TransformationPlan, edit: PlannedTextEdit): TextEdit => ({
  projectConfigFileName: edit.projectId,
  fileName: edit.fileName,
  start: edit.start,
  end: edit.end,
  newText: edit.newText,
  expectedTextHash: edit.expectedTextHash,
  evidence: edit.evidenceIds,
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
    const afterText = yield* applyFileEdits(beforeText, edits.map((edit) => editForApply(plan, edit))).pipe(
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

export interface PlanApplicationService {
  readonly apply: (
    verified: VerifiedPlan,
  ) => Effect.Effect<ApplicationReceipt, StalePlanError | ApplicationFailure | ApplicationIndeterminate, FileSystem.FileSystem | Path.Path>
}

export class PlanApplication extends Context.Service<PlanApplication, PlanApplicationService>()(
  "@teamod/internal/PlanApplication",
) {}

export const applicationLayer = (workspaceRoot: string): Layer.Layer<PlanApplication> => Layer.succeed(
  PlanApplication,
  PlanApplication.of({
    apply: Effect.fn("PlanApplication.apply")(function*(verified: VerifiedPlan) {
      const { plan, preview } = verified
      const staged: Array<{ readonly target: string; readonly temporary: string; readonly isDelete?: boolean }> = []
      const applied: Array<FilePreview> = []

      // Application revalidates the entire semantic input snapshot, not only
      // files that happen to receive edits.
      for (const source of plan.sources) {
        const target = yield* absoluteFileName(plan, workspaceRoot, source.projectId, source.fileName)
        const current = yield* FileSystem.FileSystem.use((fs) => fs.readFileString(target)).pipe(Effect.mapError(() => new StalePlanError({
            planId: plan.planId,
            projectId: source.projectId,
            fileName: source.fileName,
          })))
        if (textHash(current) !== source.hash) {
          return yield* new StalePlanError({
            planId: plan.planId,
            projectId: source.projectId,
            fileName: source.fileName,
          })
        }
      }

      for (const file of preview.files) {
        const target = yield* absoluteFileName(plan, workspaceRoot, file.projectId, file.fileName)
        if (file.beforeText === "") {
          // New file creation
          const path = yield* Path.Path
          const fs = yield* FileSystem.FileSystem
          yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
            Effect.mapError((cause) => new ApplicationFailure({ planId: plan.planId, cause, rolledBack: false })),
          )
          const temporary = `${target}.teamod-${randomUUID()}.tmp`
          yield* FileSystem.FileSystem.use((fs) => fs.writeFileString(temporary, file.afterText)).pipe(
            Effect.mapError((cause) => new ApplicationFailure({ planId: plan.planId, cause, rolledBack: true })),
          )
          staged.push({ target, temporary, isDelete: false })
        } else if (file.afterText === "") {
          // File deletion
          staged.push({ target, temporary: "", isDelete: true })
        } else {
          const current = yield* FileSystem.FileSystem.use((fs) => fs.readFileString(target)).pipe(Effect.mapError(() => new StalePlanError({
              planId: plan.planId,
              projectId: file.projectId,
              fileName: file.fileName,
            })))
          if (textHash(current) !== file.beforeHash) {
            return yield* new StalePlanError({
              planId: plan.planId,
              projectId: file.projectId,
              fileName: file.fileName,
            })
          }
          const temporary = `${target}.teamod-${randomUUID()}.tmp`
          yield* FileSystem.FileSystem.use((fs) => fs.writeFileString(temporary, file.afterText)).pipe(
            Effect.mapError((cause) => new ApplicationFailure({ planId: plan.planId, cause, rolledBack: true })),
          )
          staged.push({ target, temporary, isDelete: false })
        }
      }

      const applyExit = yield* Effect.gen(function*() {
          for (let index = 0; index < staged.length; index++) {
            const item = staged[index]!
            if (item.isDelete) {
              yield* FileSystem.FileSystem.use((fs) => fs.remove(item.target, { force: true }))
            } else {
              yield* FileSystem.FileSystem.use((fs) => fs.rename(item.temporary, item.target))
            }
            applied.push(preview.files[index]!)
          }
      }).pipe(Effect.exit)

      if (applyExit._tag === "Failure") {
        const cause = applyExit.cause
        const rollback = yield* Effect.gen(function*() {
            for (const file of applied) {
              const target = yield* absoluteFileName(plan, workspaceRoot, file.projectId, file.fileName)
              yield* FileSystem.FileSystem.use((fs) => fs.writeFileString(target, file.beforeText))
            }
            for (const item of staged) yield* FileSystem.FileSystem.use((fs) => fs.remove(item.temporary, { force: true }))
        }).pipe(Effect.exit)
        if (rollback._tag === "Failure") {
          return yield* new ApplicationIndeterminate({
            planId: plan.planId,
            cause,
            rollbackCause: rollback.cause,
          })
        }
        return yield* new ApplicationFailure({ planId: plan.planId, cause, rolledBack: true })
      }

      return {
        planId: plan.planId,
        snapshotHash: plan.snapshotHash,
        outputs: preview.files.map((file) => ({
          projectId: file.projectId,
          fileName: file.fileName,
          hash: file.afterHash,
        })),
      }
    }),
  }),
)
