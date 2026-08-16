import { randomUUID } from "node:crypto"
import { Effect, FileSystem, Layer, Path } from "effect"
import {
  ApplicationFailure,
  ApplicationIndeterminate,
  PlanApplication,
} from "../Application/Model.ts"
import { textHash } from "../Edit/index.ts"
import type { TransformationPlan } from "../Plan/index.ts"
import { StalePlanError, type FilePreview, type VerifiedPlan } from "../Verification/Engine.ts"
import { isProjectRelativePath } from "../Workspace/ProjectPath.ts"
import { Workspace } from "../Workspace/index.ts"
import { layer as nodeLayer } from "../platform/node.ts"

/** Node filesystem implementation of the sole write-authority service. */
export const applicationLayerNode: Layer.Layer<
  PlanApplication | FileSystem.FileSystem | Path.Path,
  never,
  Workspace
> = Layer.unwrap(
  Workspace.use((workspace) => Effect.succeed(makeApplicationLayerNode(workspace.root))),
)

/** Node-backed application service without leaking filesystem authority upward. */
export const makeApplicationLayerNode = (
  workspaceRoot: string,
): Layer.Layer<PlanApplication | FileSystem.FileSystem | Path.Path> =>
  Layer.merge(applicationLayer(workspaceRoot), nodeLayer)

const isContained = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

const asApplicationFailure = (
  planId: string,
  cause: unknown,
  rolledBack = false,
): ApplicationFailure => new ApplicationFailure({ planId, cause, rolledBack })

/**
 * Resolve a durable project-relative path and enforce both lexical and real
 * filesystem containment. The nearest existing parent check prevents a
 * symlinked directory from redirecting a valid-looking path outside the
 * project between plan decoding and application.
 */
const safeTarget = (
  plan: TransformationPlan,
  workspaceRoot: string,
  projectId: string,
  fileName: string,
): Effect.Effect<string, ApplicationFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const project = plan.projects.find((candidate) => candidate.id === projectId)
    if (
      project === undefined ||
      !isProjectRelativePath(fileName) ||
      !isProjectRelativePath(project.configFileName)
    ) {
      return yield* asApplicationFailure(
        plan.planId,
        `Unsafe or unknown project path: ${projectId}:${fileName}`,
      )
    }

    const root = path.resolve(workspaceRoot)
    const configFile = path.resolve(root, project.configFileName)
    const projectRoot = path.dirname(configFile)
    const target = path.resolve(projectRoot, fileName)
    if (
      !isContained(path, root, projectRoot) ||
      !isContained(path, projectRoot, target) ||
      target === projectRoot
    ) {
      return yield* asApplicationFailure(
        plan.planId,
        `Path escapes project: ${projectId}:${fileName}`,
      )
    }

    const realProjectRoot = yield* fs
      .realPath(projectRoot)
      .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause)))
    const realWorkspaceRoot = yield* fs
      .realPath(root)
      .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause)))
    if (!isContained(path, realWorkspaceRoot, realProjectRoot)) {
      return yield* asApplicationFailure(
        plan.planId,
        `Project root escapes workspace through symlink: ${projectId}`,
      )
    }
    let existingParent = path.dirname(target)
    while (
      !(yield* fs
        .exists(existingParent)
        .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause))))
    ) {
      if (existingParent === projectRoot) break
      const parent = path.dirname(existingParent)
      if (parent === existingParent || !isContained(path, projectRoot, parent)) {
        return yield* asApplicationFailure(
          plan.planId,
          `Path escapes project through parent: ${fileName}`,
        )
      }
      existingParent = parent
    }
    const realParent = yield* fs
      .realPath(existingParent)
      .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause)))
    if (!isContained(path, realProjectRoot, realParent)) {
      return yield* asApplicationFailure(
        plan.planId,
        `Path escapes project through symlink: ${fileName}`,
      )
    }

    const targetExists = yield* fs
      .exists(target)
      .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause)))
    if (targetExists) {
      const realTarget = yield* fs
        .realPath(target)
        .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause)))
      if (!isContained(path, realProjectRoot, realTarget)) {
        return yield* asApplicationFailure(
          plan.planId,
          `Target escapes project through symlink: ${fileName}`,
        )
      }
    }
    return target
  })

const checkExpectedState = (
  plan: TransformationPlan,
  workspaceRoot: string,
  file: FilePreview,
): Effect.Effect<string, StalePlanError | ApplicationFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const target = yield* safeTarget(plan, workspaceRoot, file.projectId, file.fileName)
    const exists = yield* fs
      .exists(target)
      .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause)))
    if (exists !== file.before.exists) {
      return yield* new StalePlanError({
        planId: plan.planId,
        projectId: file.projectId,
        fileName: file.fileName,
      })
    }
    if (exists) {
      const current = yield* fs.readFileString(target).pipe(
        Effect.mapError(
          () =>
            new StalePlanError({
              planId: plan.planId,
              projectId: file.projectId,
              fileName: file.fileName,
            }),
        ),
      )
      if (textHash(current) !== file.before.hash) {
        return yield* new StalePlanError({
          planId: plan.planId,
          projectId: file.projectId,
          fileName: file.fileName,
        })
      }
    }
    return target
  })

interface StagedFile {
  readonly file: FilePreview
  readonly target: string
  readonly temporary?: string | undefined
}

/**
 * The service-only layer is intentionally exported from this module (but not
 * the public Node barrel) so failure-injection tests can provide a controlled
 * FileSystem implementation.
 */
export const applicationLayer = (workspaceRoot: string): Layer.Layer<PlanApplication> =>
  Layer.succeed(
    PlanApplication,
    PlanApplication.of({
      apply: Effect.fn("PlanApplication.apply")(function* (verified: VerifiedPlan) {
        const { plan, preview } = verified
        const staged: Array<StagedFile> = []
        const applied: Array<StagedFile> = []
        const createdDirectories: Array<string> = []
        let committed = false

        const cleanup = Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          for (const item of staged) {
            if (item.temporary !== undefined) {
              yield* fs.remove(item.temporary, { force: true }).pipe(Effect.ignore)
            }
          }
          if (!committed) {
            for (const directory of [...createdDirectories].reverse()) {
              yield* fs.remove(directory, { force: true }).pipe(Effect.ignore)
            }
          }
        })

        return yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path

          // Revalidate every fingerprint, including inputs not directly edited.
          for (const source of plan.sources) {
            const target = yield* safeTarget(plan, workspaceRoot, source.projectId, source.fileName)
            const current = yield* fs.readFileString(target).pipe(
              Effect.mapError(
                () =>
                  new StalePlanError({
                    planId: plan.planId,
                    projectId: source.projectId,
                    fileName: source.fileName,
                  }),
              ),
            )
            if (textHash(current) !== source.hash) {
              return yield* new StalePlanError({
                planId: plan.planId,
                projectId: source.projectId,
                fileName: source.fileName,
              })
            }
          }

          // Stage every resulting file before changing any target. Missing
          // parent directories are tracked so a failed transaction removes them.
          const stageExit = yield* Effect.gen(function* () {
            for (const file of preview.files) {
              const target = yield* checkExpectedState(plan, workspaceRoot, file)
              let temporary: string | undefined
              if (file.after.exists) {
                const parent = path.dirname(target)
                const missing: Array<string> = []
                let current = parent
                while (!(yield* fs.exists(current))) {
                  missing.push(current)
                  current = path.dirname(current)
                }
                for (const directory of missing.reverse()) {
                  // Non-recursive creation fails if another process wins the
                  // race, so cleanup never claims a directory it did not make.
                  yield* fs.makeDirectory(directory)
                  if (!createdDirectories.includes(directory)) createdDirectories.push(directory)
                }
                temporary = `${target}.safemods-${randomUUID()}.tmp`
                staged.push({ file, target, temporary })
                yield* fs.writeFileString(temporary, file.after.text ?? "", { flag: "wx" })
              } else {
                staged.push({ file, target })
              }
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof StalePlanError ? error : asApplicationFailure(plan.planId, error),
            ),
            Effect.result,
          )

          if (stageExit._tag === "Failure") return yield* stageExit.failure

          // Re-check each precondition immediately before its filesystem state
          // transition. This closes the create-target race after verification.
          const commitExit = yield* Effect.gen(function* () {
            for (const item of staged) {
              yield* checkExpectedState(plan, workspaceRoot, item.file)
              if (!item.file.after.exists) {
                yield* fs.remove(item.target)
                applied.push(item)
              } else {
                if (!item.file.before.exists) {
                  // A rename would silently replace a concurrently-created
                  // target. Linking the staged inode is no-clobber on the
                  // filesystem, after which the temporary name can be removed.
                  yield* fs.link(item.temporary!, item.target)
                  applied.push(item)
                  yield* fs.remove(item.temporary!, { force: true }).pipe(Effect.ignore)
                } else {
                  yield* fs.rename(item.temporary!, item.target)
                  applied.push(item)
                }
              }
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof StalePlanError ? error : asApplicationFailure(plan.planId, error),
            ),
            Effect.result,
          )

          if (commitExit._tag === "Failure") {
            const rollbackExit = yield* Effect.gen(function* () {
              for (const item of [...applied].reverse()) {
                // Containment is enforced again for every inverse transition.
                const target = yield* safeTarget(
                  plan,
                  workspaceRoot,
                  item.file.projectId,
                  item.file.fileName,
                )
                if (!item.file.before.exists) {
                  yield* fs.remove(target, { force: true })
                } else {
                  const rollbackTemporary = `${target}.safemods-rollback-${randomUUID()}.tmp`
                  yield* Effect.gen(function* () {
                    yield* fs.writeFileString(rollbackTemporary, item.file.before.text ?? "", {
                      flag: "wx",
                    })
                    yield* fs.rename(rollbackTemporary, target)
                  }).pipe(
                    Effect.ensuring(
                      fs.remove(rollbackTemporary, { force: true }).pipe(Effect.ignore),
                    ),
                  )
                }
              }
            }).pipe(Effect.result)

            if (rollbackExit._tag === "Failure") {
              return yield* new ApplicationIndeterminate({
                planId: plan.planId,
                cause: commitExit.failure,
                rollbackCause: rollbackExit.failure,
              })
            }
            if (commitExit.failure instanceof StalePlanError) return yield* commitExit.failure
            return yield* asApplicationFailure(plan.planId, commitExit.failure.cause, true)
          }

          committed = true
          return {
            planId: plan.planId,
            snapshotHash: plan.snapshotHash,
            outputs: preview.files.map((file) => ({
              projectId: file.projectId,
              fileName: file.fileName,
              hash: file.after.hash ?? "",
            })),
          }
        }).pipe(Effect.ensuring(cleanup))
      }),
    }),
  )
