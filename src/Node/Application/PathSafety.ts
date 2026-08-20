import { Effect, FileSystem, Path } from "effect"
import { isProjectRelativePath } from "../../ProjectPath/index.ts"
import type { TransformationPlan } from "../../Plan/index.ts"
import { asApplicationFailure } from "./Failure.ts"

export const isContained = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

export const resolveContainedPath = (
  path: Path.Path,
  workspaceRoot: string,
  candidate: string,
): string | undefined => {
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate)
  return isContained(path, workspaceRoot, resolved) ? resolved : undefined
}

/**
 * Resolve a durable project-relative path and enforce both lexical and real
 * filesystem containment. The nearest existing parent check prevents a
 * symlinked directory from redirecting a valid-looking path outside the
 * project between plan decoding and application.
 */
export const safeTarget = (
  plan: TransformationPlan,
  workspaceRoot: string,
  projectId: string,
  fileName: string,
): Effect.Effect<
  string,
  ReturnType<typeof asApplicationFailure>,
  FileSystem.FileSystem | Path.Path
> =>
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
