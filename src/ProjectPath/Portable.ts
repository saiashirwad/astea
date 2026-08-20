/** Portable project-relative path identity for durable values. */
import { Data } from "effect"

/** A canonical path which is safe to resolve below a project root. */
export type ProjectRelativePath = string & { readonly __projectRelativePath: unique symbol }

export class InvalidProjectRelativePath extends Data.TaggedError("InvalidProjectRelativePath")<{
  readonly path: string
}> {}

const canonicalPath = (value: string): string | undefined => {
  if (value.length === 0 || value.includes("\0")) return undefined
  // Durable plans are portable, so reject POSIX and Windows absolute spellings.
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
    // A colon is a drive or device spelling on Windows. It is not portable.
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
