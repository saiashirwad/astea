/** Verification and application service engine. */
import { Data, Effect, FileSystem, Path } from "effect"
import { applyFileEdits, textHash } from "../Edit/index.ts"
import type { DiagnosticDiff } from "../Policy/index.ts"
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

export type FileState =
  | { readonly exists: false; readonly text?: undefined; readonly hash?: undefined }
  | { readonly exists: true; readonly text: string; readonly hash: string }

export interface FilePreview {
  readonly projectId: string
  readonly fileName: string
  /** Explicit operation and virtual existence state; empty text is valid content. */
  readonly action: "create" | "modify" | "delete" | "move"
  readonly before: FileState
  readonly after: FileState
  /** The counterpart path for a move operation, when applicable. */
  readonly movePath?: string | undefined
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
  readonly secondPlanChangeCount?: number
  readonly diagnosticDiff: DiagnosticDiff
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
  type VirtualFile = { readonly exists: boolean; readonly text: string }
  const keyOf = (projectId: string, fileName: string): string => `${projectId}\0${fileName}`
  const sourceTexts = new Map<string, VirtualFile>()
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
    sourceTexts.set(keyOf(source.projectId, source.fileName), { exists: true, text: content })
  }

  const initial = new Map(sourceTexts)
  const touched = new Set<string>()
  const moveCounterpart = new Map<string, string>()
  const operationKinds = new Map<string, "create" | "delete" | "move">()
  const stateOf = (file: VirtualFile): FileState => file.exists
    ? { exists: true, text: file.text, hash: textHash(file.text) }
    : { exists: false }
  for (const op of plan.fileOperations ?? []) {
    const sourceKey = keyOf(op.projectId, op.path)
    if (op.kind === "create") {
      sourceTexts.set(sourceKey, { exists: true, text: op.content })
      touched.add(sourceKey)
      operationKinds.set(sourceKey, "create")
    } else if (op.kind === "delete") {
      const before = sourceTexts.get(sourceKey)
      if (before?.exists !== true) {
        return yield* new VerificationFailure({ planId: plan.planId, policy: "edits", detail: `Missing source for ${sourceKey}` })
      }
      if (textHash(before.text) !== op.initialHash) {
        return yield* new StalePlanError({ planId: plan.planId, projectId: op.projectId, fileName: op.path })
      }
      sourceTexts.set(sourceKey, { exists: false, text: "" })
      touched.add(sourceKey)
      operationKinds.set(sourceKey, "delete")
    } else {
      const before = sourceTexts.get(sourceKey)
      if (before?.exists !== true) {
        return yield* new VerificationFailure({ planId: plan.planId, policy: "edits", detail: `Missing source for ${sourceKey}` })
      }
      if (textHash(before.text) !== op.initialHash) {
        return yield* new StalePlanError({ planId: plan.planId, projectId: op.projectId, fileName: op.path })
      }
      const targetKey = keyOf(op.projectId, op.toPath)
      sourceTexts.set(sourceKey, { exists: false, text: "" })
      sourceTexts.set(targetKey, { exists: true, text: op.content ?? before.text })
      touched.add(sourceKey)
      touched.add(targetKey)
      operationKinds.set(sourceKey, "move")
      operationKinds.set(targetKey, "move")
      moveCounterpart.set(sourceKey, op.toPath)
      moveCounterpart.set(targetKey, op.path)
    }
  }

  const groups = Map.groupBy(plan.edits, (edit) => `${edit.projectId}\0${edit.fileName}`)
  const filesByKey = new Map<string, FilePreview>()
  for (const [key, edits] of groups) {
    const before = sourceTexts.get(key)
    if (before?.exists !== true) {
      return yield* new VerificationFailure({
        planId: plan.planId,
        policy: "edits",
        detail: `Missing source for ${key}`,
      })
    }
    const afterText = yield* applyFileEdits(before.text, edits).pipe(
      Effect.mapError((error) => new VerificationFailure({
        planId: plan.planId,
        policy: "edits",
        detail: error._tag,
      })),
    )
    sourceTexts.set(key, { exists: true, text: afterText })
    touched.add(key)
  }

  for (const key of touched) {
    const [projectId, fileName] = key.split("\0") as [string, string]
    const before = initial.get(key) ?? { exists: false, text: "" }
    const after = sourceTexts.get(key) ?? { exists: false, text: "" }
    const operation = operationKinds.get(key)
    const action = operation ?? (before.exists ? "modify" : "create")
    filesByKey.set(key, {
      projectId,
      fileName,
      action,
      before: stateOf(before),
      after: stateOf(after),
      movePath: moveCounterpart.get(key),
    })
  }

  const files = [...filesByKey.values()]
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
    observation.diagnosticDiff.introduced.some((d) => d.category === "error")
  ) {
    return yield* new VerificationFailure({
      planId: plan.planId,
      policy: "diagnostics",
      detail: `${observation.baselineErrorCount} -> ${observation.proposedErrorCount}; introduced error diagnostics are not permitted`,
    })
  }
  if (plan.policies.idempotence === "required" && observation.secondPlanChangeCount !== 0) {
    return yield* new VerificationFailure({
      planId: plan.planId,
      policy: "idempotence",
      detail: "Second recipe run was not empty",
    })
  }

  // Do not mint a VerifiedPlan containing a failed built-in result, even when
  // a caller constructed the observation directly rather than going through
  // Core's policy checks above.
  const failedBuiltIn = observation.policyResults?.find((result) => !result.passed)
  if (failedBuiltIn !== undefined) {
    return yield* new VerificationFailure({
      planId: plan.planId,
      policy: failedBuiltIn.name === "idempotence"
        ? "idempotence"
        : failedBuiltIn.name === "match-count"
        ? "matches"
        : failedBuiltIn.name === "affected-files"
        ? "affected-files"
        : "diagnostics",
      detail: failedBuiltIn.detail ?? `Policy '${failedBuiltIn.name}' failed`,
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
