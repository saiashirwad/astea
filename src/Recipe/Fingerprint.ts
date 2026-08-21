/** Durable workspace input fingerprinting. */
import { Effect, FileSystem, Path, Predicate } from "effect"
import { textHash } from "../Edit/index.ts"
import type { Json } from "../Evidence/index.ts"
import type { SourceFingerprint } from "../Plan/index.ts"
import { parseProjectRelativePath, type ProjectRelativePath } from "../ProjectPath/index.ts"
import {
  hashDirectoryListing,
  type ProjectNotInSnapshot,
  type SnapshotExpired,
  type WorkspaceCompilerError,
  type WorkspaceSnapshotService,
} from "../Workspace/index.ts"

const relativePath = (
  path: Path.Path,
  projectRoot: string,
  absolute: string,
): ProjectRelativePath | undefined =>
  parseProjectRelativePath(
    path.relative(path.resolve(projectRoot), path.resolve(absolute)).split(path.sep).join("/"),
  )

const observationRelativePath = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  projectRoot: string,
  absolute: string,
): Effect.Effect<ProjectRelativePath | undefined> =>
  Effect.gen(function* () {
    const direct = relativePath(path, projectRoot, absolute)
    if (direct !== undefined) return direct

    const realRoot = yield* fs.realPath(projectRoot).pipe(Effect.orElseSucceed(() => undefined))
    if (realRoot === undefined) return undefined
    const realAbsolute = yield* fs.realPath(absolute).pipe(Effect.orElseSucceed(() => absolute))
    return relativePath(path, realRoot, realAbsolute)
  })

const parseExtendsSpecifiers = (text: string): ReadonlyArray<string> => {
  try {
    // SAFETY: JSON.parse returns the configuration document read above.
    const parsed = JSON.parse(text) as Json
    if (!Predicate.isObject(parsed) || Array.isArray(parsed)) return []
    const value = parsed.extends
    if (Predicate.isString(value)) return [value]
    if (Array.isArray(value)) return value.filter(Predicate.isString)
    return []
  } catch {
    return []
  }
}

const resolveExtendsPath = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  fromDir: string,
  specifier: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    if (!(specifier.startsWith("./") || specifier.startsWith("../"))) return undefined
    const resolved = path.resolve(fromDir, specifier)
    if (yield* fs.exists(resolved).pipe(Effect.orElseSucceed(() => false))) return resolved
    if (
      !resolved.endsWith(".json") &&
      (yield* fs.exists(`${resolved}.json`).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return `${resolved}.json`
    }
    return resolved
  })

const collectExtendsParents = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  configFileName: string,
): Effect.Effect<Array<string>> =>
  Effect.gen(function* () {
    const parents: Array<string> = []
    const seen = new Set<string>([configFileName])
    const queue = [configFileName]
    while (queue.length > 0) {
      const current = queue.shift()!
      const text = yield* fs
        .readFileString(current, "utf8")
        .pipe(Effect.orElseSucceed(() => undefined))
      if (text === undefined) continue
      for (const specifier of parseExtendsSpecifiers(text)) {
        const next = yield* resolveExtendsPath(fs, path, path.dirname(current), specifier)
        if (next === undefined || seen.has(next)) continue
        seen.add(next)
        parents.push(next)
        queue.push(next)
      }
    }
    return parents
  })

const fingerprintKey = (source: SourceFingerprint): string =>
  `${source.projectId}\0${source.kind ?? "file"}\0${source.fileName}`

const addFingerprint = (
  sources: Map<string, SourceFingerprint>,
  source: SourceFingerprint,
): void => {
  const relative = parseProjectRelativePath(source.fileName)
  if (relative === undefined) return
  const next = { ...source, fileName: relative }
  sources.set(fingerprintKey(next), next)
}

const resolvedProjectRelative = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  projectRoot: string,
  absolute: string,
): Effect.Effect<ProjectRelativePath | undefined> =>
  fs.realPath(absolute).pipe(
    Effect.flatMap((resolved) => observationRelativePath(fs, path, projectRoot, resolved)),
    Effect.orElseSucceed(() => undefined),
  )

const directoryListingHash = (
  fs: FileSystem.FileSystem,
  directory: string,
): Effect.Effect<string | undefined> =>
  fs.readDirectory(directory).pipe(
    Effect.map(hashDirectoryListing),
    Effect.orElseSucceed(() => undefined),
  )

/** Record compiler inputs that verification can revalidate. */
export const fingerprintWorkspace = (
  workspaceRoot: string,
  snapshot: WorkspaceSnapshotService,
): Effect.Effect<
  ReadonlyArray<SourceFingerprint>,
  WorkspaceCompilerError | ProjectNotInSnapshot | SnapshotExpired,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const sources = new Map<string, SourceFingerprint>()
    for (const configured of snapshot.projects) {
      const project = yield* snapshot.project(configured)
      const owned = (yield* project.sourceFileNames).filter(
        (fileName) => relativePath(path, project.root, fileName) !== undefined,
      )
      const files = [...new Set(owned)].sort()
      const configFileName = path.resolve(workspaceRoot, configured.config)
      const contentFiles = [
        configFileName,
        ...files,
        ...(yield* collectExtendsParents(fs, path, configFileName)),
      ]
      const directories = new Set<string>()
      for (const absolute of contentFiles) {
        const relative = yield* observationRelativePath(fs, path, project.root, absolute)
        if (relative === undefined) continue
        const content = yield* fs
          .readFileString(absolute, "utf8")
          .pipe(Effect.orElseSucceed(() => undefined))
        if (content === undefined) {
          addFingerprint(sources, {
            projectId: configured.id,
            fileName: relative,
            hash: "",
            kind: "missing",
          })
        } else {
          addFingerprint(sources, {
            projectId: configured.id,
            fileName: relative,
            hash: textHash(content),
          })
          const directory = path.dirname(absolute)
          if ((yield* observationRelativePath(fs, path, project.root, directory)) !== undefined) {
            directories.add(directory)
          }
          const resolvedRelative = yield* resolvedProjectRelative(fs, path, project.root, absolute)
          if (resolvedRelative !== undefined && resolvedRelative !== relative) {
            addFingerprint(sources, {
              projectId: configured.id,
              fileName: relative,
              hash: textHash(resolvedRelative),
              kind: "realpath",
            })
          }
        }
      }
      for (const directory of [...directories].sort()) {
        const relative = yield* observationRelativePath(fs, path, project.root, directory)
        if (relative === undefined) continue
        const listing = yield* directoryListingHash(fs, directory)
        addFingerprint(sources, {
          projectId: configured.id,
          fileName: relative,
          hash: listing ?? "",
          kind: listing === undefined ? "missing" : "directory",
        })
      }
    }
    return [...sources.values()].sort(
      (left, right) =>
        left.projectId.localeCompare(right.projectId) ||
        left.fileName.localeCompare(right.fileName) ||
        (left.kind ?? "file").localeCompare(right.kind ?? "file"),
    )
  })
