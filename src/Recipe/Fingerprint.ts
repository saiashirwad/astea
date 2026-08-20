/** Durable workspace input fingerprinting. */
import { path as Path, nodeFs as NodeFs, nodeFsPromises as Fs } from "../platform/node.ts"
import { Effect, Predicate } from "effect"
import { NativeCompilerError } from "../Compiler/Service.ts"
import { textHash } from "../Edit/index.ts"
import type { Json, SourceFingerprint } from "../Plan/index.ts"
import {
  isWithinProject,
  parseProjectRelativePath,
  projectRelativePath,
} from "../Workspace/ProjectPath.ts"
import {
  hashDirectoryListing,
  type ProjectNotInSnapshot,
  type SnapshotExpired,
  type WorkspaceSnapshotService,
} from "../Workspace/index.ts"

const readText = (fileName: string): Effect.Effect<string, NativeCompilerError> =>
  Effect.tryPromise({
    try: () => Fs.readFile(fileName, "utf8"),
    catch: (cause) => new NativeCompilerError({ operation: "read workspace input", cause }),
  })

const observationRelativePath = (projectRoot: string, absolute: string): string | undefined => {
  const direct = parseProjectRelativePath(projectRelativePath(projectRoot, absolute))
  if (direct !== undefined) return direct
  try {
    const realRoot = NodeFs.realpathSync(projectRoot)
    let realAbsolute = absolute
    try {
      realAbsolute = NodeFs.realpathSync(absolute)
    } catch {
      if (realAbsolute.startsWith(`${realRoot}${Path.sep}`) || realAbsolute === realRoot) {
        return parseProjectRelativePath(projectRelativePath(realRoot, realAbsolute))
      }
    }
    if (realAbsolute === realRoot || realAbsolute.startsWith(`${realRoot}${Path.sep}`)) {
      return parseProjectRelativePath(projectRelativePath(realRoot, realAbsolute))
    }
  } catch {
    return undefined
  }
  return undefined
}

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

const resolveExtendsPath = (fromDir: string, specifier: string): string | undefined => {
  if (!(specifier.startsWith("./") || specifier.startsWith("../"))) return undefined
  const resolved = Path.resolve(fromDir, specifier)
  if (NodeFs.existsSync(resolved)) return resolved
  if (!resolved.endsWith(".json") && NodeFs.existsSync(`${resolved}.json`)) {
    return `${resolved}.json`
  }
  return resolved
}

const collectExtendsParents = (configFileName: string): Array<string> => {
  const parents: Array<string> = []
  const seen = new Set<string>([configFileName])
  const queue = [configFileName]
  while (queue.length > 0) {
    const current = queue.shift()!
    let text: string
    try {
      text = NodeFs.readFileSync(current, "utf8")
    } catch {
      continue
    }
    for (const specifier of parseExtendsSpecifiers(text)) {
      const next = resolveExtendsPath(Path.dirname(current), specifier)
      if (next === undefined || seen.has(next)) continue
      seen.add(next)
      parents.push(next)
      queue.push(next)
    }
  }
  return parents
}

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

const resolvedProjectRelative = (projectRoot: string, absolute: string): string | undefined => {
  try {
    return observationRelativePath(projectRoot, NodeFs.realpathSync(absolute))
  } catch {
    return undefined
  }
}

const directoryListingHash = (directory: string): string | undefined => {
  try {
    return hashDirectoryListing(NodeFs.readdirSync(directory))
  } catch {
    return undefined
  }
}

/** Record compiler inputs that verification can revalidate. */
export const fingerprintWorkspace = (
  workspaceRoot: string,
  snapshot: WorkspaceSnapshotService,
): Effect.Effect<
  ReadonlyArray<SourceFingerprint>,
  NativeCompilerError | ProjectNotInSnapshot | SnapshotExpired
> =>
  Effect.gen(function* () {
    const sources = new Map<string, SourceFingerprint>()
    for (const configured of snapshot.projects) {
      const project = yield* snapshot.project(configured)
      const owned = (yield* project.sourceFileNames).filter((fileName) =>
        isWithinProject(project.root, fileName),
      )
      const files = [...new Set(owned)].sort()
      const configFileName = Path.resolve(workspaceRoot, configured.config)
      const contentFiles = [configFileName, ...files, ...collectExtendsParents(configFileName)]
      const directories = new Set<string>()
      for (const absolute of contentFiles) {
        const relative = observationRelativePath(project.root, absolute)
        if (relative === undefined) continue
        const content = yield* readText(absolute).pipe(Effect.orElseSucceed(() => undefined))
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
          const directory = Path.dirname(absolute)
          if (observationRelativePath(project.root, directory) !== undefined) {
            directories.add(directory)
          }
          const resolvedRelative = resolvedProjectRelative(project.root, absolute)
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
        const relative = observationRelativePath(project.root, directory)
        if (relative === undefined) continue
        const listing = directoryListingHash(directory)
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
