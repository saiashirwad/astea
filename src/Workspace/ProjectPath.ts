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
  return normalized as ProjectRelativePath | undefined
}

export const isProjectRelativePath = (value: string): value is ProjectRelativePath =>
  parseProjectRelativePath(value) === value

export const requireProjectRelativePath = (value: string): ProjectRelativePath => {
  const parsed = parseProjectRelativePath(value)
  if (parsed === undefined) throw new InvalidProjectRelativePath({ path: value })
  return parsed
}

export const isWithinProject = (projectRoot: string, fileName: string): boolean => {
  const root = Path.resolve(projectRoot)
  const file = Path.resolve(fileName)
  return file.toLowerCase().startsWith(`${root.toLowerCase()}${Path.sep}`)
}

export const projectRelativePath = (projectRoot: string, fileName: string): string => {
  const root = Path.resolve(projectRoot)
  const file = Path.resolve(fileName)
  if (file.toLowerCase().startsWith(`${root.toLowerCase()}${Path.sep}`)) {
    return file.slice(root.length + 1)
  }
  return Path.relative(root, file)
}
