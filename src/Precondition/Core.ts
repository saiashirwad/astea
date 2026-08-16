/**
 * Precondition domain — file-level and project-level filters.
 *
 * Preconditions allow transformation recipes and queries to pre-filter candidate files
 * (using fast text, path, and import matching) before invoking expensive AST traversals
 * and type-checker operations.
 */
import { Effect, Predicate } from "effect"
import type { ProjectFile, ProjectSnapshot, ProjectSnapshotError } from "../Workspace/index.ts"

export interface FilePrecondition<E = never, R = never> {
  readonly _tag: "FilePrecondition"
  readonly id: string
  readonly evaluate: (
    file: ProjectFile,
  ) => Effect.Effect<boolean, E | ProjectSnapshotError, R>
}

const testRegExp = (regex: RegExp, value: string): boolean => {
  const fresh = new RegExp(regex.source, regex.flags)
  return fresh.test(value)
}

const normalizePath = (path: string): string =>
  path.replace(/\\/g, "/")

const globToRegex = (glob: string): RegExp => {
  const escaped = glob
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*\*/g, "<<DOUBLE_STAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<DOUBLE_STAR>>/g, ".*")
  return new RegExp(`^${escaped}$`)
}

const IMPORT_SPECIFIER_PATTERNS = [
  // static import or export ... from "..."
  /(?:from|import)\s*['"`]([^'"`]+)['"`]/g,
  // dynamic import("...") or require("...")
  /(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
]

const extractSpecifiers = (text: string): ReadonlySet<string> => {
  const specifiers = new Set<string>()
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    const fresh = new RegExp(pattern.source, pattern.flags)
    let match: RegExpExecArray | null
    while ((match = fresh.exec(text)) !== null) {
      const spec = match[1]
      if (spec !== undefined) {
        specifiers.add(spec)
      }
    }
  }
  return specifiers
}

const matchesSpecifier = (
  actual: string,
  expected: string | RegExp,
): boolean => {
  if (!Predicate.isString(expected)) {
    return testRegExp(expected, actual)
  }
  if (actual === expected) {
    return true
  }
  // Strip relative extensions for convenience: e.g. "./library.js" matches "./library" or "./library.ts"
  const stripExt = (s: string) => s.replace(/\.[jt]sx?$/, "")
  return stripExt(actual) === stripExt(expected)
}

/**
 * Filter for files whose raw source text contains the given substring.
 */
export const fileTextIncludes = (substring: string): FilePrecondition => ({
  _tag: "FilePrecondition",
  id: `fileTextIncludes(${JSON.stringify(substring)})`,
  evaluate: (file) =>
    file.sourceText.pipe(
      Effect.map((text) => text.includes(substring)),
      Effect.catchTag("FileNotFound", () => Effect.succeed(false)),
    ),
})

/**
 * Filter for files whose raw source text matches the given RegExp or pattern.
 * Safely resets/clones stateful regexes (`/g` and `/y`) to prevent cross-file side-effects.
 */
export const fileTextMatches = (pattern: RegExp | string): FilePrecondition => {
  const regex = Predicate.isString(pattern) ? new RegExp(pattern) : pattern
  const id = `fileTextMatches(${pattern.toString()})`
  return {
    _tag: "FilePrecondition",
    id,
    evaluate: (file) =>
      file.sourceText.pipe(
        Effect.map((text) => testRegExp(regex, text)),
        Effect.catchTag("FileNotFound", () => Effect.succeed(false)),
      ),
  }
}

/**
 * Conservative filter for files that import or require the given module specifier.
 * Detects static imports, re-exports, dynamic `import(...)`, and `require(...)`.
 */
export const hasImport = (specifier: string | RegExp): FilePrecondition => {
  const id = `hasImport(${specifier.toString()})`
  return {
    _tag: "FilePrecondition",
    id,
    evaluate: (file) =>
      file.sourceText.pipe(
        Effect.map((text) => {
          if (Predicate.isString(specifier)) {
            const base = specifier.replace(/\.[jt]sx?$/, "")
            // Fast text check before regex extraction
            if (!text.includes(specifier) && !text.includes(base)) {
              return false
            }
          }
          const importedSpecifiers = extractSpecifiers(text)
          for (const s of importedSpecifiers) {
            if (matchesSpecifier(s, specifier)) {
              return true
            }
          }
          return false
        }),
        Effect.catchTag("FileNotFound", () => Effect.succeed(false)),
      ),
  }
}

/**
 * Filter for files whose project-relative path matches the given pattern or glob.
 */
export const pathMatches = (pattern: RegExp | string): FilePrecondition => {
  const id = `pathMatches(${pattern.toString()})`
  const regex = Predicate.isString(pattern)
    ? pattern.includes("*")
      ? globToRegex(pattern)
      : undefined
    : pattern

  return {
    _tag: "FilePrecondition",
    id,
    evaluate: (file) => {
      const normalized = normalizePath(file.path)
      if (regex !== undefined) {
        return Effect.succeed(testRegExp(regex, normalized))
      }
      if (Predicate.isString(pattern)) {
        const rawPattern = normalizePath(pattern)
        const matches = normalized === rawPattern ||
          normalized.endsWith(rawPattern) ||
          normalized.includes(rawPattern)
        return Effect.succeed(matches)
      }
      return Effect.succeed(false)
    },
  }
}

/**
 * Evaluates all preconditions; returns `true` only if every precondition matches.
 */
export const all = <E = never, R = never>(
  ...conditions: ReadonlyArray<FilePrecondition<E, R>>
): FilePrecondition<E, R> => ({
  _tag: "FilePrecondition",
  id: `all(${conditions.map((c) => c.id).join(", ")})`,
  evaluate: (file) =>
    Effect.gen(function*() {
      for (const condition of conditions) {
        const passed = yield* condition.evaluate(file)
        if (!passed) {
          return false
        }
      }
      return true
    }),
})

/**
 * Evaluates all preconditions; returns `true` if any precondition matches.
 */
export const any = <E = never, R = never>(
  ...conditions: ReadonlyArray<FilePrecondition<E, R>>
): FilePrecondition<E, R> => ({
  _tag: "FilePrecondition",
  id: `any(${conditions.map((c) => c.id).join(", ")})`,
  evaluate: (file) =>
    Effect.gen(function*() {
      for (const condition of conditions) {
        const passed = yield* condition.evaluate(file)
        if (passed) {
          return true
        }
      }
      return false
    }),
})

/**
 * Inverts the given precondition.
 */
export const not = <E = never, R = never>(
  condition: FilePrecondition<E, R>,
): FilePrecondition<E, R> => ({
  _tag: "FilePrecondition",
  id: `not(${condition.id})`,
  evaluate: (file) =>
    condition.evaluate(file).pipe(
      Effect.map((passed) => !passed),
    ),
})

/**
 * Creates a custom file precondition with an explicit stable identifier and evaluation function.
 */
export const custom = <E = never, R = never>(
  id: string,
  evaluate: (file: ProjectFile) => Effect.Effect<boolean, E | ProjectSnapshotError, R>,
): FilePrecondition<E, R> => ({
  _tag: "FilePrecondition",
  id,
  evaluate,
})

/**
 * Evaluates whether a single ProjectFile satisfies a precondition.
 */
export const satisfies = <E = never, R = never>(
  file: ProjectFile,
  condition: FilePrecondition<E, R>,
): Effect.Effect<boolean, E | ProjectSnapshotError, R> =>
  condition.evaluate(file)

const isProjectFileArray = (
  value: ProjectSnapshot | ReadonlyArray<ProjectFile>,
): value is ReadonlyArray<ProjectFile> => Array.isArray(value)

/**
 * Evaluates candidate files from a ProjectSnapshot or ProjectFile collection against a precondition,
 * returning the deduplicated, deterministic path-sorted matching subset.
 */
export const filesMatching = <E = never, R = never>(
  target: ProjectSnapshot | ReadonlyArray<ProjectFile>,
  condition: FilePrecondition<E, R>,
): Effect.Effect<ReadonlyArray<ProjectFile>, E | ProjectSnapshotError, R> =>
  Effect.gen(function*() {
    const candidates: ReadonlyArray<ProjectFile> = isProjectFileArray(target)
      ? target
      : yield* target.files

    if (candidates.length === 0) {
      return []
    }

    const evaluated = yield* Effect.forEach(
      candidates,
      (file) =>
        condition.evaluate(file).pipe(
          Effect.map((matched): [ProjectFile, boolean] => [file, matched]),
        ),
      { concurrency: 16 },
    )

    const matchedFiles = evaluated
      .filter(([, matched]) => matched)
      .map(([file]) => file)

    const seen = new Set<string>()
    const unique: Array<ProjectFile> = []
    for (const f of matchedFiles) {
      const key = `${f.project.project.id}:${f.path}`
      if (!seen.has(key)) {
        seen.add(key)
        unique.push(f)
      }
    }

    return unique.sort((a, b) => a.path.localeCompare(b.path))
  })
