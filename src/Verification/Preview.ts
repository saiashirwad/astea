/** Read-only materialization of a plan's exact proposed bytes. */
import { Effect, type FileSystem, Path } from "effect"
import { textHash } from "../Edit/index.ts"
import {
  isContentFingerprint,
  type PlanDecodeError,
  validatePlan,
  type TransformationPlan,
} from "../Plan/index.ts"
import { isProjectRelativePath } from "../ProjectPath/index.ts"
import {
  materialize as materializeVirtualFs,
  virtualFileKey,
  type VirtualFsInitialFile,
  VirtualFsError,
} from "../VirtualFs/index.ts"
import { Workspace } from "../Workspace/index.ts"
import { type ProjectIdentityMismatch, StalePlanError, VerificationFailure } from "./Errors.ts"
import { requireMatchingProjectIdentity, revalidateSource } from "./SourceRevalidation.ts"

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

export const previewPlan = (
  plan: TransformationPlan,
  workspaceRoot: string,
): Effect.Effect<
  PlanPreview,
  StalePlanError | VerificationFailure | PlanDecodeError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const validated = yield* validatePlan(plan)
    const path = yield* Path.Path
    const initialFiles: Array<VirtualFsInitialFile> = []
    const initial = new Map<string, string>()
    for (const source of validated.sources) {
      const content = yield* revalidateSource(validated, workspaceRoot, source)
      if (!isContentFingerprint(source) || content === undefined) continue
      initialFiles.push({
        projectId: source.projectId,
        fileName: source.fileName,
        content,
      })
      initial.set(virtualFileKey(source.projectId, source.fileName), content)
    }

    const resolvePath = (projectId: string, fileName: string): string => {
      const project = validated.projects.find((candidate) => candidate.id === projectId)
      if (
        project === undefined ||
        !isProjectRelativePath(fileName) ||
        !isProjectRelativePath(project.configFileName)
      ) {
        throw new Error(`Unsafe or unknown project path: ${projectId}:${fileName}`)
      }
      return path.resolve(workspaceRoot, path.dirname(project.configFileName), fileName)
    }

    const materialized = yield* materializeVirtualFs<never>({
      initialFiles,
      // Every source used by a valid plan is fingerprinted above. This loader
      // is only a defensive boundary for malformed plans.
      load: (projectId, fileName) =>
        Effect.die(new Error(`Missing fingerprint for ${projectId}:${fileName}`)),
      resolvePath,
      edits: validated.edits,
      fileOperations: validated.fileOperations,
    }).pipe(
      Effect.mapError((error) => {
        if (error instanceof VirtualFsError) {
          if (error.reason === "source-mismatch") {
            return new StalePlanError({
              planId: validated.planId,
              projectId: error.projectId,
              fileName: error.fileName,
            })
          }
          return new VerificationFailure({
            planId: validated.planId,
            policy: "edits",
            detail: `Missing source for ${error.projectId}\0${error.fileName}`,
          })
        }
        return new VerificationFailure({
          planId: validated.planId,
          policy: "edits",
          detail: error._tag,
        })
      }),
    )

    const touched = new Set<string>()
    const moveCounterpart = new Map<string, string>()
    const operationKinds = new Map<string, "create" | "delete" | "move">()
    for (const operation of validated.fileOperations ?? []) {
      const sourceKey = virtualFileKey(operation.projectId, operation.path)
      touched.add(sourceKey)
      if (operation.kind === "create") {
        operationKinds.set(sourceKey, "create")
      } else if (operation.kind === "delete") {
        operationKinds.set(sourceKey, "delete")
      } else {
        const targetKey = virtualFileKey(operation.projectId, operation.toPath)
        touched.add(targetKey)
        operationKinds.set(sourceKey, "move")
        operationKinds.set(targetKey, "move")
        moveCounterpart.set(sourceKey, operation.toPath)
        moveCounterpart.set(targetKey, operation.path)
      }
    }

    for (const edit of validated.edits) {
      touched.add(virtualFileKey(edit.projectId, edit.fileName))
    }

    const filesByKey = new Map<string, FilePreview>()
    const stateOf = (text: string | undefined): FileState =>
      text === undefined ? { exists: false } : { exists: true, text, hash: textHash(text) }
    for (const key of touched) {
      // SAFETY: every virtualFileKey is created from exactly one project ID and file name.
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
    return { planId: validated.planId, snapshotHash: validated.snapshotHash, files }
  })

/** Materialize a validated preview against the active Workspace. Never writes. */
export const of = (
  plan: TransformationPlan,
): Effect.Effect<
  PlanPreview,
  StalePlanError | VerificationFailure | PlanDecodeError | ProjectIdentityMismatch,
  Workspace | FileSystem.FileSystem | Path.Path
> =>
  Workspace.use((workspace) =>
    Effect.gen(function* () {
      const validated = yield* validatePlan(plan)
      yield* requireMatchingProjectIdentity(validated, workspace.definition.projects)
      return yield* previewPlan(validated, workspace.root)
    }),
  )
