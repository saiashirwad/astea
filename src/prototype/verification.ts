/** PROTOTYPE — read-only preview/verification and separately authorized application. */
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { randomUUID } from "node:crypto"
import { Context, Data, Effect, Layer } from "effect"
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
}

const VerifiedPlanTypeId: unique symbol = Symbol.for("@teatime/prototype/VerifiedPlan") as never

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
): string => {
  const project = plan.projects.find((candidate) => candidate.id === projectId)
  if (project === undefined) throw new Error(`Unknown project ID: ${projectId}`)
  return Path.resolve(workspaceRoot, Path.dirname(project.configFileName), fileName)
}

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
): Effect.Effect<PlanPreview, StalePlanError | VerificationFailure> => Effect.gen(function*() {
  const sourceTexts = new Map<string, string>()
  for (const source of plan.sources) {
    const absolute = absoluteFileName(plan, workspaceRoot, source.projectId, source.fileName)
    const content = yield* Effect.tryPromise({
      try: () => Fs.readFile(absolute, "utf8"),
      catch: () => new StalePlanError({
        planId: plan.planId,
        projectId: source.projectId,
        fileName: source.fileName,
      }),
    })
    if (textHash(content) !== source.hash) {
      return yield* new StalePlanError({
        planId: plan.planId,
        projectId: source.projectId,
        fileName: source.fileName,
      })
    }
    sourceTexts.set(`${source.projectId}\0${source.fileName}`, content)
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
  }
  return { [VerifiedPlanTypeId]: VerifiedPlanTypeId, plan, preview, receipt }
})

export interface PlanApplicationService {
  readonly apply: (
    verified: VerifiedPlan,
  ) => Effect.Effect<ApplicationReceipt, StalePlanError | ApplicationFailure | ApplicationIndeterminate>
}

export class PlanApplication extends Context.Service<PlanApplication, PlanApplicationService>()(
  "@teatime/prototype/PlanApplication",
) {}

export const applicationLayer = (workspaceRoot: string): Layer.Layer<PlanApplication> => Layer.succeed(
  PlanApplication,
  PlanApplication.of({
    apply: Effect.fn("PlanApplication.apply")(function*(verified: VerifiedPlan) {
      const { plan, preview } = verified
      const staged: Array<{ readonly target: string; readonly temporary: string }> = []
      const applied: Array<FilePreview> = []

      // Application revalidates the entire semantic input snapshot, not only
      // files that happen to receive edits.
      for (const source of plan.sources) {
        const target = absoluteFileName(plan, workspaceRoot, source.projectId, source.fileName)
        const current = yield* Effect.tryPromise({
          try: () => Fs.readFile(target, "utf8"),
          catch: () => new StalePlanError({
            planId: plan.planId,
            projectId: source.projectId,
            fileName: source.fileName,
          }),
        })
        if (textHash(current) !== source.hash) {
          return yield* new StalePlanError({
            planId: plan.planId,
            projectId: source.projectId,
            fileName: source.fileName,
          })
        }
      }

      for (const file of preview.files) {
        const target = absoluteFileName(plan, workspaceRoot, file.projectId, file.fileName)
        const current = yield* Effect.tryPromise({
          try: () => Fs.readFile(target, "utf8"),
          catch: () => new StalePlanError({
            planId: plan.planId,
            projectId: file.projectId,
            fileName: file.fileName,
          }),
        })
        if (textHash(current) !== file.beforeHash) {
          return yield* new StalePlanError({
            planId: plan.planId,
            projectId: file.projectId,
            fileName: file.fileName,
          })
        }
        const temporary = `${target}.teatime-${randomUUID()}.tmp`
        yield* Effect.tryPromise({
          try: () => Fs.writeFile(temporary, file.afterText),
          catch: (cause) => new ApplicationFailure({ planId: plan.planId, cause, rolledBack: true }),
        })
        staged.push({ target, temporary })
      }

      const applyExit = yield* Effect.tryPromise({
        try: async () => {
          for (let index = 0; index < staged.length; index++) {
            await Fs.rename(staged[index]!.temporary, staged[index]!.target)
            applied.push(preview.files[index]!)
          }
        },
        catch: (cause) => cause,
      }).pipe(Effect.exit)

      if (applyExit._tag === "Failure") {
        const cause = applyExit.cause
        const rollback = yield* Effect.tryPromise({
          try: async () => {
            for (const file of applied) {
              const target = absoluteFileName(plan, workspaceRoot, file.projectId, file.fileName)
              await Fs.writeFile(target, file.beforeText)
            }
            for (const item of staged) await Fs.rm(item.temporary, { force: true })
          },
          catch: (rollbackCause) => rollbackCause,
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
