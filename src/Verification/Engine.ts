/** Verification and application service engine. */
import { Data, Effect, FileSystem, Path } from "effect"
import { textHash } from "../Edit/index.ts"
import type { DiagnosticDiff } from "../Policy/index.ts"
import type { TransformationPlan } from "../Plan/index.ts"
import {
  materialize as materializeVirtualFs,
  virtualFileKey,
  type VirtualFsInitialFile,
  VirtualFsError,
} from "../VirtualFs/index.ts"

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
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const project = plan.projects.find((candidate) => candidate.id === projectId)
    if (project === undefined)
      return yield* Effect.die(new Error(`Unknown project ID: ${projectId}`))
    return path.resolve(workspaceRoot, path.dirname(project.configFileName), fileName)
  })

export const previewPlan = (
  plan: TransformationPlan,
  workspaceRoot: string,
): Effect.Effect<
  PlanPreview,
  StalePlanError | VerificationFailure,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const initialFiles: Array<VirtualFsInitialFile> = []
    const initial = new Map<string, string>()
    for (const source of plan.sources) {
      const absolute = yield* absoluteFileName(
        plan,
        workspaceRoot,
        source.projectId,
        source.fileName,
      )
      const content = yield* FileSystem.FileSystem.use((fs) => fs.readFileString(absolute)).pipe(
        Effect.mapError(
          () =>
            new StalePlanError({
              planId: plan.planId,
              projectId: source.projectId,
              fileName: source.fileName,
            }),
        ),
      )
      if (textHash(content) !== source.hash) {
        return yield* new StalePlanError({
          planId: plan.planId,
          projectId: source.projectId,
          fileName: source.fileName,
        })
      }
      initialFiles.push({
        projectId: source.projectId,
        fileName: source.fileName,
        content,
      })
      initial.set(virtualFileKey(source.projectId, source.fileName), content)
    }

    const resolvePath = (projectId: string, fileName: string): string => {
      const project = plan.projects.find((candidate) => candidate.id === projectId)
      if (project === undefined) throw new Error(`Unknown project ID: ${projectId}`)
      return path.resolve(workspaceRoot, path.dirname(project.configFileName), fileName)
    }

    const materialized = yield* materializeVirtualFs<never>({
      initialFiles,
      // Every source used by a valid plan is fingerprinted above. This loader
      // is only a defensive boundary for malformed plans.
      load: (projectId, fileName) =>
        Effect.die(new Error(`Missing fingerprint for ${projectId}:${fileName}`)),
      resolvePath,
      edits: plan.edits,
      ...(plan.fileOperations === undefined ? {} : { fileOperations: plan.fileOperations }),
    }).pipe(
      Effect.mapError((error) => {
        if (error instanceof VirtualFsError) {
          if (error.reason === "source-mismatch") {
            return new StalePlanError({
              planId: plan.planId,
              projectId: error.projectId,
              fileName: error.fileName,
            })
          }
          return new VerificationFailure({
            planId: plan.planId,
            policy: "edits",
            detail: `Missing source for ${error.projectId}\\0${error.fileName}`,
          })
        }
        return new VerificationFailure({
          planId: plan.planId,
          policy: "edits",
          detail: error._tag,
        })
      }),
    )

    const touched = new Set<string>()
    const moveCounterpart = new Map<string, string>()
    const operationKinds = new Map<string, "create" | "delete" | "move">()
    for (const op of plan.fileOperations ?? []) {
      const sourceKey = virtualFileKey(op.projectId, op.path)
      touched.add(sourceKey)
      if (op.kind === "create") {
        operationKinds.set(sourceKey, "create")
      } else if (op.kind === "delete") {
        operationKinds.set(sourceKey, "delete")
      } else {
        const targetKey = virtualFileKey(op.projectId, op.toPath)
        touched.add(targetKey)
        operationKinds.set(sourceKey, "move")
        operationKinds.set(targetKey, "move")
        moveCounterpart.set(sourceKey, op.toPath)
        moveCounterpart.set(targetKey, op.path)
      }
    }

    for (const edit of plan.edits) {
      touched.add(virtualFileKey(edit.projectId, edit.fileName))
    }

    const filesByKey = new Map<string, FilePreview>()
    const stateOf = (text: string | undefined): FileState =>
      text === undefined ? { exists: false } : { exists: true, text, hash: textHash(text) }
    for (const key of touched) {
      const [projectId, fileName] = key.split("\0") as [string, string]
      const absolute = resolvePath(projectId, fileName)
      const before = initial.get(key)
      const after = materialized.deleted.has(absolute)
        ? undefined
        : materialized.files.get(absolute)
      const operation = operationKinds.get(key)
      const action = operation ?? (before === undefined ? "create" : "modify")
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
    files.sort(
      (left, right) =>
        left.projectId.localeCompare(right.projectId) ||
        left.fileName.localeCompare(right.fileName),
    )
    return { planId: plan.planId, snapshotHash: plan.snapshotHash, files }
  })

export const verifyPreview = (
  plan: TransformationPlan,
  preview: PlanPreview,
  observation: VerificationObservation,
): Effect.Effect<VerifiedPlan, VerificationFailure> =>
  Effect.gen(function* () {
    const { min, max } = plan.policies.matchCount
    if (
      (min !== undefined && observation.actualMatches < min) ||
      (max !== undefined && observation.actualMatches > max)
    ) {
      return yield* new VerificationFailure({
        planId: plan.planId,
        policy: "matches",
        detail: `Observed ${observation.actualMatches}`,
      })
    }
    if (
      plan.policies.maxAffectedFiles !== undefined &&
      preview.files.length > plan.policies.maxAffectedFiles
    ) {
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
        policy:
          failedBuiltIn.name === "idempotence"
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
