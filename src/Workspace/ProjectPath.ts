/** Workspace project-relative path identity. */
import { path as Path } from "../platform/node.ts"
import { Data } from "effect"

/** A canonical path which is safe to resolve below a project root. */
export type ProjectRelativePath = string & { readonly __projectRelativePath: unique symbol }

export class InvalidProjectRelativePath extends Data.TaggedError("InvalidProjectRelativePath")<{
  readonly path: string
}> {}

const canonicalPath = (value: string): string | undefined => {
  if (value.length === 0 || value.includes("\0")) return undefined
  // `path.isAbsolute` only understands the host platform. Durable plans are
  // portable, so reject both POSIX and Windows absolute spellings explicitly.
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value))
    return undefined
  const parts = value.replaceAll("\\", "/").split("/")
  const result: Array<string> = []
  for (const part of parts) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (result.length === 0) return undefined
      result.pop()
      continue
    }
    // A colon in a component is a drive/device spelling on Windows (and is
    // not a valid portable project-relative filename).
    if (part.includes(":")) return undefined
    result.push(part)
  }
  return result.length === 0 ? undefined : result.join("/")
}

/** Parse and normalize a portable project-relative path. */
export const parseProjectRelativePath = (value: string): ProjectRelativePath | undefined => {
  const normalized = canonicalPath(value)
  // SAFETY: canonicalPath returns only normalized project-relative paths.
  return normalized as ProjectRelativePath | undefined
}

export const isProjectRelativePath = (value: string): value is ProjectRelativePath =>
  parseProjectRelativePath(value) === value

export const requireProjectRelativePath = (value: string): ProjectRelativePath => {
  const parsed = parseProjectRelativePath(value)
  if (parsed === undefined) throw new InvalidProjectRelativePath({ path: value })
  return parsed
}

/**
 * Platform-aware containment: host separators and `path.relative`, without a
 * universal lowercase compare that would merge distinct case-sensitive paths.
 */
const isContained = (root: string, candidate: string): boolean => {
  const relative = Path.relative(root, candidate)
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${Path.sep}`) && !Path.isAbsolute(relative))
  )
}

/** True when `fileName` is a descendant of `projectRoot`. Comparison preserves case. */
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
 * Resolve a snapshot lookup path. Project-relative inputs and already-contained
 * absolute compiler paths are accepted; `../` escape and external paths are not.
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
