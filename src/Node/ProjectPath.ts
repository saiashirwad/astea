/** Node host-path resolution and project containment. */
import { path as Path } from "../platform/node.ts"
import { parseProjectRelativePath } from "../ProjectPath/index.ts"

/**
 * Platform-aware containment. Preserve case so distinct paths on a
 * case-sensitive filesystem do not become one path.
 */
const isContained = (root: string, candidate: string): boolean => {
  const relative = Path.relative(root, candidate)
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${Path.sep}`) && !Path.isAbsolute(relative))
  )
}

/** True when `fileName` is a descendant of `projectRoot`. */
export const isWithinProject = (projectRoot: string, fileName: string): boolean => {
  const root = Path.resolve(projectRoot)
  const file = Path.resolve(fileName)
  return file !== root && isContained(root, file)
}

export const projectRelativePath = (projectRoot: string, fileName: string): string =>
  Path.relative(Path.resolve(projectRoot), Path.resolve(fileName))

/** Resolve a project-relative path that stays inside `projectRoot`. */
export const resolveProjectRelativeFile = (
  projectRoot: string,
  fileName: string,
): string | undefined => {
  const relative = parseProjectRelativePath(fileName)
  if (relative === undefined) return undefined
  const absolute = Path.resolve(projectRoot, relative)
  return isWithinProject(projectRoot, absolute) ? absolute : undefined
}

/**
 * Resolve a snapshot lookup path. Accept project-relative inputs and absolute
 * compiler paths that are already in the project.
 */
export const resolveContainedSnapshotPath = (
  projectRoot: string,
  fileName: string,
): string | undefined => {
  const relative = resolveProjectRelativeFile(projectRoot, fileName)
  if (relative !== undefined) return relative
  if (!Path.isAbsolute(fileName)) return undefined
  const absolute = Path.resolve(fileName)
  return isWithinProject(projectRoot, absolute) ? absolute : undefined
}
