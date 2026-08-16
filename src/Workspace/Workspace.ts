/**
 * Workspace domain — workspace authority and snapshot regions.
 *
 * `Workspace` is the application service: it owns workspace configuration,
 * read-only source access, native compiler lifecycle, transition
 * serialization, and isolated verification sessions. `WorkspaceSnapshot` is
 * the region-provided capability that keeps native values honest about their
 * generation. `ConfiguredProject` and `ProjectSnapshot` are plain values.
 */
import { path as Path } from "../platform/node.ts"
import { Context, Data, Effect, Layer, Option, Predicate, Semaphore } from "effect"
import type { SourceFile } from "typescript/unstable/ast"
import type {
  APIOptions,
  Project as NativeProject,
  Symbol as NativeSymbol,
  Type as NativeType,
} from "typescript/unstable/async"
import { SymbolFlags } from "typescript/unstable/async"
import type { FileChanges } from "typescript/unstable/proto"
import {
  layer as nativeCompilerLayer,
  NativeCompiler,
  type NativeCompilerError,
  nativeRequest,
} from "../Compiler/Service.ts"
import { isWithinProject, projectRelativePath } from "./ProjectPath.ts"

export type { NativeCompilerError }

const ConfiguredProjectTypeId: unique symbol = Symbol.for("@safemods/ConfiguredProject")

/**
 * A stable project identity within a Workspace. `id` is the durable identity
 * used in plans, selections, and evidence; `config` is the workspace-relative
 * path of the TypeScript configuration file. Absolute paths are runtime
 * lookup details and never appear in durable artifacts.
 */
export interface ConfiguredProject {
  readonly [ConfiguredProjectTypeId]: typeof ConfiguredProjectTypeId
  readonly id: string
  readonly config: string
}

export const ConfiguredProject = {
  make: (options: { readonly id: string; readonly config: string }): ConfiguredProject => {
    const project: ConfiguredProject = {
      [ConfiguredProjectTypeId]: ConfiguredProjectTypeId,
      id: options.id,
      config: options.config,
    }
    return Object.freeze(project)
  },
}

export interface WorkspaceDefinition {
  readonly projects: readonly [ConfiguredProject, ...ReadonlyArray<ConfiguredProject>]
}

export type WorkspaceChanges =
  | { readonly invalidateAll: true }
  | {
    readonly changed?: ReadonlyArray<string>
    readonly created?: ReadonlyArray<string>
    readonly deleted?: ReadonlyArray<string>
  }

export interface SnapshotTransition {
  readonly changes?: WorkspaceChanges
}

export class DuplicateConfiguredProject extends Data.TaggedError("DuplicateConfiguredProject")<{
  readonly id: string
  readonly configFileName: string
}> {}

export class ProjectNotInSnapshot extends Data.TaggedError("ProjectNotInSnapshot")<{
  readonly projectId: string
  readonly generation: number
}> {}

export class SnapshotExpired extends Data.TaggedError("SnapshotExpired")<{
  readonly generation: number
}> {}

export class SymbolNotFound extends Data.TaggedError("SymbolNotFound")<{
  readonly name: string
  readonly fileName: string
}> {}

export class FileNotFound extends Data.TaggedError("FileNotFound")<{
  readonly fileName: string
  readonly projectId: string
}> {}

export type ProjectSnapshotError = NativeCompilerError | SnapshotExpired

export const ProjectFileTypeSymbol = Symbol.for("@safemods/ProjectFile")

export interface DependencyGraphOptions {
  /**
   * Whether to recursively traverse indirect / transitive file references
   * (e.g. through intermediate barrel files or re-exports). Defaults to `false`.
   */
  readonly transitive?: boolean
}

/**
 * A validated reference to an existing source file in a Project Snapshot.
 * Bundles file existence proof, project identity, and scoped queries together.
 */
export interface ProjectFile {
  readonly [ProjectFileTypeSymbol]: true
  readonly project: ProjectSnapshot
  readonly path: string
  readonly sourceFile: Effect.Effect<SourceFile, FileNotFound | ProjectSnapshotError>
  readonly sourceText: Effect.Effect<string, FileNotFound | ProjectSnapshotError>
  readonly symbolNamed: (
    name: string,
  ) => Effect.Effect<NativeSymbol, SymbolNotFound | ProjectSnapshotError>
  readonly findSymbolNamed: (
    name: string,
  ) => Effect.Effect<Option.Option<NativeSymbol>, ProjectSnapshotError>
  readonly symbolAt: (
    position: number,
  ) => Effect.Effect<NativeSymbol | undefined, ProjectSnapshotError>
  readonly typeAt: (
    position: number,
  ) => Effect.Effect<NativeType | undefined, ProjectSnapshotError>
  /**
   * Files in the project that import or reference this file (dependents / consumers).
   * When `transitive: true`, recursively traverses the dependent graph (e.g. through barrel re-exports).
   */
  readonly referencingFiles: (
    options?: DependencyGraphOptions,
  ) => Effect.Effect<ReadonlyArray<ProjectFile>, ProjectSnapshotError>
  /**
   * Files in the project that this file imports or references (upstream dependencies).
   * When `transitive: true`, recursively traverses the dependency graph.
   */
  readonly referencedFiles: (
    options?: DependencyGraphOptions,
  ) => Effect.Effect<ReadonlyArray<ProjectFile>, ProjectSnapshotError>
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Type guard boundary for ProjectFile handles.
export const isProjectFile = (value: unknown): value is ProjectFile =>
  Predicate.isObject(value) && ProjectFileTypeSymbol in value

/**
 * A checked view of one Configured Project within a particular Workspace
 * Snapshot. All native values reached through it are valid only while the
 * producing region is active.
 */
export interface ProjectSnapshot {
  readonly project: ConfiguredProject
  /** Absolute directory containing the project configuration. Runtime detail; never durable. */
  readonly root: string
  readonly rootFiles: ReadonlyArray<string>
  readonly sourceFileNames: Effect.Effect<ReadonlyArray<string>, ProjectSnapshotError>
  readonly sourceFile: (fileName: string) => Effect.Effect<SourceFile | undefined, ProjectSnapshotError>
  readonly sourceText: (fileName: string) => Effect.Effect<string, FileNotFound | ProjectSnapshotError>
  /** Retrieve a validated reference to an existing file, failing fast if absent. */
  readonly file: (
    fileName: string,
  ) => Effect.Effect<ProjectFile, FileNotFound | ProjectSnapshotError>
  /** Look up an optional validated reference to a file. */
  readonly findFile: (
    fileName: string,
  ) => Effect.Effect<Option.Option<ProjectFile>, ProjectSnapshotError>
  /** All source files in the project as validated ProjectFile references. */
  readonly files: Effect.Effect<ReadonlyArray<ProjectFile>, ProjectSnapshotError>
  readonly semanticDiagnosticCount: Effect.Effect<number, ProjectSnapshotError>
  /** Resolve the symbol at a position in a project-relative file. */
  readonly symbolAt: (
    fileName: string,
    position: number,
  ) => Effect.Effect<NativeSymbol | undefined, ProjectSnapshotError>
  /**
   * Find the canonical symbol declared under `name` in a project-relative
   * file, resolving through import aliases. Convenience over `symbolAt` so
   * recipes never hand-compute declaration positions.
   */
  readonly symbolNamed: (
    name: string,
    options: { readonly within: string },
  ) => Effect.Effect<NativeSymbol, SymbolNotFound | ProjectSnapshotError>
  /**
   * Find the canonical symbol declared under `name` in a project-relative
   * file, returning `Option.none()` if not found instead of failing.
   */
  readonly findSymbolNamed: (
    name: string,
    options: { readonly within: string },
  ) => Effect.Effect<Option.Option<NativeSymbol>, ProjectSnapshotError>
  /** Resolve the type at a position in a project-relative file. */
  readonly typeAt: (
    fileName: string,
    position: number,
  ) => Effect.Effect<NativeType | undefined, ProjectSnapshotError>
  /** String representation of a type. */
  readonly typeToString: (type: NativeType) => Effect.Effect<string, ProjectSnapshotError>
  /** Check if `fromType` is assignable to `toType`. */
  readonly isTypeAssignableTo: (
    fromType: NativeType,
    toType: NativeType,
  ) => Effect.Effect<boolean, ProjectSnapshotError>
  /** Intrinsic native types. */
  readonly intrinsicType: (
    kind: "string" | "number" | "boolean" | "any" | "unknown" | "never" | "void",
  ) => Effect.Effect<NativeType, ProjectSnapshotError>
  /** Explicitly unstable escape hatch. Native values remain region-bound. */
  readonly unsafeNative: <A, E, R>(
    use: (project: NativeProject) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SnapshotExpired, R>
}

export interface WorkspaceSnapshotService {
  readonly generation: number
  readonly projects: ReadonlyArray<ConfiguredProject>
  readonly project: (
    project: ConfiguredProject,
  ) => Effect.Effect<ProjectSnapshot, ProjectNotInSnapshot | SnapshotExpired>
}

export class WorkspaceSnapshot extends Context.Service<WorkspaceSnapshot, WorkspaceSnapshotService>()(
  "@safemods/WorkspaceSnapshot",
) {}

export interface WorkspaceService {
  readonly definition: WorkspaceDefinition
  /** Absolute workspace root. Runtime configuration, not durable identity. */
  readonly root: string
  readonly withSnapshot: <A, E, R>(
    transition: SnapshotTransition,
    program: Effect.Effect<A, E, R | WorkspaceSnapshot>,
  ) => Effect.Effect<A, E | NativeCompilerError | ProjectNotInSnapshot, Exclude<R, WorkspaceSnapshot>>
  /**
   * Run a program against a fresh compiler authority over a virtual
   * filesystem: `overlay` (absolute file name to proposed content) wins, and
   * every other read falls through to the real workspace. Nothing writes.
   * This is the isolated session Verification is built on.
   */
  readonly withIsolatedSnapshot: <A, E, R>(
    overlay: Readonly<Record<string, string>>,
    program: Effect.Effect<A, E, R | WorkspaceSnapshot>,
  ) => Effect.Effect<A, E | NativeCompilerError | ProjectNotInSnapshot, Exclude<R, WorkspaceSnapshot>>
}

export class Workspace extends Context.Service<Workspace, WorkspaceService>()(
  "@safemods/Workspace",
) {
  static readonly layerWithoutDependencies = (
    definition: WorkspaceDefinition,
    options: APIOptions = {},
  ): Layer.Layer<Workspace, DuplicateConfiguredProject, NativeCompiler> =>
    layerWithoutDependencies(definition, options)
  static readonly layer = (
    definition: WorkspaceDefinition,
    options: APIOptions = {},
  ): Layer.Layer<Workspace, DuplicateConfiguredProject> => layer(definition, options)
}

interface NativeFileChangeLists {
  changed?: Array<string>
  created?: Array<string>
  deleted?: Array<string>
}

interface OpenSnapshotParams {
  openProjects?: Array<string>
  fileChanges?: FileChanges
}

const toNativeChanges = (changes: WorkspaceChanges | undefined): FileChanges | undefined => {
  if (changes === undefined) return undefined
  if ("invalidateAll" in changes) return { invalidateAll: true }
  const result: NativeFileChangeLists = {}
  if (changes.changed !== undefined) {
    result.changed = [...changes.changed]
  }
  if (changes.created !== undefined) {
    result.created = [...changes.created]
  }
  if (changes.deleted !== undefined) {
    result.deleted = [...changes.deleted]
  }
  return result
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const make = (
  definition: WorkspaceDefinition,
  apiOptions: APIOptions,
): Effect.Effect<Workspace["Service"], DuplicateConfiguredProject, NativeCompiler> =>
  Effect.gen(function*() {
    const compiler = yield* NativeCompiler
    const transitionLock = yield* Semaphore.make(1)
    const root = Path.resolve(apiOptions.cwd ?? ".")

    const projects = Object.freeze([...definition.projects])
    const resolvedById = new Map<string, string>()
    for (const project of projects) {
      const configFileName = Path.resolve(root, project.config)
      if (resolvedById.has(project.id) || [...resolvedById.values()].includes(configFileName)) {
        return yield* new DuplicateConfiguredProject({ id: project.id, configFileName })
      }
      resolvedById.set(project.id, configFileName)
    }

    let opened = false

    const openRegion = <A, E, R>(
      regionCompiler: NativeCompiler["Service"],
      openProjects: ReadonlyArray<string> | undefined,
      transition: SnapshotTransition,
      onOpened: () => void,
      program: Effect.Effect<A, E, R | WorkspaceSnapshot>,
    ): Effect.Effect<A, E | NativeCompilerError, Exclude<R, WorkspaceSnapshot>> =>
      Effect.scoped(Effect.gen(function*() {
        const params: OpenSnapshotParams = {}
        if (openProjects !== undefined) {
          params.openProjects = [...openProjects]
        }
        if (transition.changes !== undefined) {
          const fileChanges = toNativeChanges(transition.changes)
          if (fileChanges !== undefined) params.fileChanges = fileChanges
        }
        const nativeSnapshot = yield* regionCompiler.openSnapshot(params).pipe(Effect.tap(() => Effect.sync(onOpened)))

        const active = { current: true }
        const ensureActive = Effect.suspend((): Effect.Effect<void, SnapshotExpired> =>
          active.current
            ? Effect.void
            : Effect.fail(new SnapshotExpired({ generation: nativeSnapshot.id })))

        const project = Effect.fn("WorkspaceSnapshot.project")(function*(configured: ConfiguredProject) {
          yield* ensureActive
          const configFileName = resolvedById.get(configured.id)
          const nativeProject = configFileName === undefined
            ? undefined
            : nativeSnapshot.getProject(configFileName)
          if (configFileName === undefined || nativeProject === undefined) {
            return yield* new ProjectNotInSnapshot({
              projectId: configured.id,
              generation: nativeSnapshot.id,
            })
          }

          const projectRoot = Path.dirname(configFileName)

          const sourceFileNames = Effect.gen(function*() {
            yield* ensureActive
            return yield* nativeRequest("getSourceFileNames", () => nativeProject.program.getSourceFileNames())
          })

          const sourceFile = Effect.fn("ProjectSnapshot.sourceFile")(function*(fileName: string) {
            yield* ensureActive
            const absolute = Path.resolve(projectRoot, fileName)
            return yield* nativeRequest(
              "getSourceFile",
              () => nativeProject.program.getSourceFile(absolute),
            )
          })

          const sourceText = Effect.fn("ProjectSnapshot.sourceText")(function*(fileName: string) {
            yield* ensureActive
            const file = yield* sourceFile(fileName)
            if (file === undefined) {
              return yield* new FileNotFound({ fileName, projectId: configured.id })
            }
            return file.text
          })

          const semanticDiagnosticCount = Effect.gen(function*() {
            yield* ensureActive
            const diagnostics = yield* nativeRequest(
              "getSemanticDiagnostics",
              () => nativeProject.program.getSemanticDiagnostics(),
            )
            return diagnostics.length
          })

          const symbolAt = Effect.fn("ProjectSnapshot.symbolAt")(function*(fileName: string, position: number) {
            yield* ensureActive
            return yield* nativeRequest(
              "getSymbolAtPosition",
              () => nativeProject.checker.getSymbolAtPosition(Path.resolve(projectRoot, fileName), position),
            )
          })

          const canonicalSymbol = (symbol: NativeSymbol) =>
            (symbol.flags & SymbolFlags.Alias) === 0
              ? Effect.succeed(symbol)
              : nativeRequest("getAliasedSymbol", () => nativeProject.checker.getAliasedSymbol(symbol))

          const symbolNamed = Effect.fn("ProjectSnapshot.symbolNamed")(
            function*(name: string, options: { readonly within: string }) {
              yield* ensureActive
              const absolute = Path.resolve(projectRoot, options.within)
              const sourceFile = yield* nativeRequest(
                "getSourceFile",
                () => nativeProject.program.getSourceFile(absolute),
              )
              if (sourceFile === undefined) {
                return yield* new SymbolNotFound({ name, fileName: options.within })
              }
              const positions = [...sourceFile.text.matchAll(new RegExp(`\\b${escapeRegExp(name)}\\b`, "g"))]
                .map((match) => match.index)
              if (positions.length === 0) {
                return yield* new SymbolNotFound({ name, fileName: options.within })
              }
              const symbols = yield* nativeRequest(
                "getSymbolsAtPositions",
                () => nativeProject.checker.getSymbolAtPosition(absolute, positions),
              )
              for (const symbol of symbols) {
                if (symbol === undefined) continue
                const canonical = yield* canonicalSymbol(symbol)
                if (canonical.name === name) return canonical
              }
              return yield* new SymbolNotFound({ name, fileName: options.within })
            },
          )

          const findSymbolNamed = Effect.fn("ProjectSnapshot.findSymbolNamed")(
            function*(name: string, options: { readonly within: string }) {
              return yield* symbolNamed(name, options).pipe(
                Effect.map(Option.some),
                Effect.catchTag("SymbolNotFound", () => Effect.succeed(Option.none())),
              )
            },
          )

          const typeAt = Effect.fn("ProjectSnapshot.typeAt")(function*(fileName: string, position: number) {
            yield* ensureActive
            const types = yield* nativeRequest(
              "getTypeAtPosition",
              () => nativeProject.checker.getTypeAtPosition(Path.resolve(projectRoot, fileName), [position]),
            )
            return types[0]
          })

          const typeToString = Effect.fn("ProjectSnapshot.typeToString")(function*(type: NativeType) {
            yield* ensureActive
            return yield* nativeRequest(
              "typeToString",
              () => nativeProject.checker.typeToString(type),
            )
          })

          const isTypeAssignableTo = Effect.fn("ProjectSnapshot.isTypeAssignableTo")(
            function*(fromType: NativeType, toType: NativeType) {
              yield* ensureActive
              return yield* nativeRequest(
                "isTypeAssignableTo",
                () => nativeProject.checker.isTypeAssignableTo(fromType, toType),
              )
            },
          )

          const intrinsicType = Effect.fn("ProjectSnapshot.intrinsicType")(
            function*(kind: "string" | "number" | "boolean" | "any" | "unknown" | "never" | "void") {
              yield* ensureActive
              return yield* nativeRequest("getIntrinsicType", () => {
                switch (kind) {
                  case "string": return nativeProject.checker.getStringType()
                  case "number": return nativeProject.checker.getNumberType()
                  case "boolean": return nativeProject.checker.getBooleanType()
                  case "any": return nativeProject.checker.getAnyType()
                  case "unknown": return nativeProject.checker.getUnknownType()
                  case "never": return nativeProject.checker.getNeverType()
                  case "void": return nativeProject.checker.getVoidType()
                }
              })
            },
          )

interface ProjectDependencyGraph {
  readonly forward: Map<string, Set<string>>
  readonly reverse: Map<string, Set<string>>
}

const traverseGraph = (
  adj: Map<string, Set<string>>,
  startPath: string,
  transitive: boolean,
): ReadonlyArray<string> => {
  if (!transitive) {
    const direct = adj.get(startPath)
    if (direct === undefined || direct.size === 0) return []
    return [...direct].sort()
  }
  const visited = new Set<string>([startPath])
  const queue = [...(adj.get(startPath) ?? [])]
  const result: Array<string> = []
  for (const next of queue) {
    if (!visited.has(next)) {
      visited.add(next)
      result.push(next)
    }
  }
  let head = 0
  while (head < result.length) {
    const curr = result[head++]!
    const neighbors = adj.get(curr)
    if (neighbors !== undefined) {
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          result.push(neighbor)
        }
      }
    }
  }
  return result.sort()
}

          const unsafeNative: ProjectSnapshot["unsafeNative"] = (use) =>
            Effect.andThen(ensureActive, Effect.suspend(() => use(nativeProject)))

          let memoizedGraph: ProjectDependencyGraph | undefined = undefined

          const getDependencyGraph = Effect.gen(function*() {
            yield* ensureActive
            if (memoizedGraph !== undefined) {
              return memoizedGraph
            }

            const allFileNames = yield* nativeRequest("getSourceFileNames", () => nativeProject.program.getSourceFileNames())
            const canonicalMap = new Map<string, string>()
            const projectFiles: Array<{ fn: string; rel: string; sf: SourceFile }> = []

            for (const fn of allFileNames) {
              const sf = yield* nativeRequest("getSourceFile", () => nativeProject.program.getSourceFile(fn))
              if (sf === undefined) continue
              const isDefault = yield* nativeRequest("isSourceFileDefaultLibrary", () => nativeProject.program.isSourceFileDefaultLibrary(sf))
              const isExternal = yield* nativeRequest("isSourceFileFromExternalLibrary", () => nativeProject.program.isSourceFileFromExternalLibrary(sf))
              if (!isDefault && !isExternal) {
                const rel = projectRelativePath(projectRoot, fn)
                canonicalMap.set(Path.resolve(fn).toLowerCase(), rel)
                projectFiles.push({ fn, rel, sf })
              }
            }

            const forward = new Map<string, Set<string>>()
            const reverse = new Map<string, Set<string>>()
            for (const { rel } of projectFiles) {
              forward.set(rel, new Set())
              reverse.set(rel, new Set())
            }

            for (const { fn, rel, sf } of projectFiles) {
              if (sf.imports !== undefined && sf.imports.length > 0) {
                const syms = yield* nativeRequest("getSymbolAtLocation", () => nativeProject.checker.getSymbolAtLocation(sf.imports))
                const symArray = Array.isArray(syms) ? syms : [syms]
                for (const sym of symArray) {
                  if (sym === undefined) continue
                  const decls = [sym.valueDeclaration, ...(sym.declarations ?? [])].filter(
                    (d): d is NonNullable<typeof d> => d !== undefined,
                  )
                  for (const d of decls) {
                    if (d.path !== undefined) {
                      const targetRel = canonicalMap.get(Path.resolve(d.path).toLowerCase())
                      if (targetRel !== undefined && targetRel !== rel) {
                        forward.get(rel)?.add(targetRel)
                        reverse.get(targetRel)?.add(rel)
                      }
                    }
                  }
                }
              }

              if (sf.referencedFiles !== undefined && sf.referencedFiles.length > 0) {
                for (const ref of sf.referencedFiles) {
                  if (ref.fileName !== undefined) {
                    const absRef = Path.resolve(Path.dirname(fn), ref.fileName)
                    const targetRel = canonicalMap.get(absRef.toLowerCase())
                    if (targetRel !== undefined && targetRel !== rel) {
                      forward.get(rel)?.add(targetRel)
                      reverse.get(targetRel)?.add(rel)
                    }
                  }
                }
              }
            }

            const graph: ProjectDependencyGraph = { forward, reverse }
            memoizedGraph = graph
            return graph
          })

          const makeProjectFile = (selfSnapshot: ProjectSnapshot, relativePath: string): ProjectFile => ({
            [ProjectFileTypeSymbol]: true,
            project: selfSnapshot,
            path: relativePath,
            sourceFile: selfSnapshot.sourceFile(relativePath).pipe(
              Effect.flatMap((sf) =>
                sf !== undefined
                  ? Effect.succeed(sf)
                  : Effect.fail(new FileNotFound({ projectId: configured.id, fileName: relativePath }))
              ),
            ),
            sourceText: selfSnapshot.sourceText(relativePath),
            symbolNamed: (name: string) => selfSnapshot.symbolNamed(name, { within: relativePath }),
            findSymbolNamed: (name: string) => selfSnapshot.findSymbolNamed(name, { within: relativePath }),
            symbolAt: (position: number) => selfSnapshot.symbolAt(relativePath, position),
            typeAt: (position: number) => selfSnapshot.typeAt(relativePath, position),
            referencingFiles: (options?: DependencyGraphOptions) =>
              Effect.gen(function*() {
                yield* ensureActive
                const graph = yield* getDependencyGraph
                const paths = traverseGraph(graph.reverse, relativePath, options?.transitive ?? false)
                return paths.map((p) => makeProjectFile(selfSnapshot, p))
              }),
            referencedFiles: (options?: DependencyGraphOptions) =>
              Effect.gen(function*() {
                yield* ensureActive
                const graph = yield* getDependencyGraph
                const paths = traverseGraph(graph.forward, relativePath, options?.transitive ?? false)
                return paths.map((p) => makeProjectFile(selfSnapshot, p))
              }),
          })

          const file = Effect.fn("ProjectSnapshot.file")(function*(fileName: string) {
            yield* ensureActive
            const rel = projectRelativePath(projectRoot, Path.resolve(projectRoot, fileName))
            const absolute = Path.resolve(projectRoot, rel)
            const sf = yield* nativeRequest(
              "getSourceFile",
              () => nativeProject.program.getSourceFile(absolute),
            )
            if (sf === undefined) {
              return yield* new FileNotFound({ projectId: configured.id, fileName: rel })
            }
            return makeProjectFile(snapshotView, rel)
          })

          const findFile = Effect.fn("ProjectSnapshot.findFile")(function*(fileName: string) {
            return yield* file(fileName).pipe(
              Effect.map(Option.some),
              Effect.catchTag("FileNotFound", () => Effect.succeed(Option.none())),
            )
          })

          const files: ProjectSnapshot["files"] = Effect.gen(function*() {
            yield* ensureActive
            const allFileNames = yield* nativeRequest("getSourceFileNames", () => nativeProject.program.getSourceFileNames())
            const projectFileHandles: Array<ProjectFile> = []
            for (const fn of allFileNames) {
              const sf = yield* nativeRequest("getSourceFile", () => nativeProject.program.getSourceFile(fn))
              if (sf === undefined) continue
              const isDefault = yield* nativeRequest("isSourceFileDefaultLibrary", () => nativeProject.program.isSourceFileDefaultLibrary(sf))
              const isExternal = yield* nativeRequest("isSourceFileFromExternalLibrary", () => nativeProject.program.isSourceFileFromExternalLibrary(sf))
              if (!isDefault && !isExternal && isWithinProject(projectRoot, fn)) {
                projectFileHandles.push(makeProjectFile(snapshotView, projectRelativePath(projectRoot, fn)))
              }
            }
            return projectFileHandles
          })

          const snapshotView: ProjectSnapshot = {
            project: configured,
            root: projectRoot,
            rootFiles: nativeProject.rootFiles,
            sourceFileNames,
            sourceFile,
            sourceText,
            file,
            findFile,
            files,
            semanticDiagnosticCount,
            symbolAt,
            symbolNamed,
            findSymbolNamed,
            typeAt,
            typeToString,
            isTypeAssignableTo,
            intrinsicType,
            unsafeNative,
          }

          return snapshotView
        })

        const snapshotService = WorkspaceSnapshot.of({
          generation: nativeSnapshot.id,
          projects,
          project,
        })

        return yield* program.pipe(
          Effect.provideService(WorkspaceSnapshot, snapshotService),
          Effect.ensuring(Effect.sync(() => {
            active.current = false
          })),
        )
      }))

    const withSnapshot: WorkspaceService["withSnapshot"] = (transition, program) =>
      transitionLock.withPermit(Effect.suspend(() => {
        const openProjects = opened ? undefined : [...resolvedById.values()]
        return openRegion(compiler, openProjects, transition, () => {
          opened = true
        }, program)
      }))

    const withIsolatedSnapshot: WorkspaceService["withIsolatedSnapshot"] = (overlay, program) => {
      const overlayOptions: APIOptions = {
        ...apiOptions,
        fs: {
          readFile: (fileName) => {
            const exact = overlay[fileName]
            if (exact !== undefined) return exact
            // The native process may observe realpath-resolved names (for
            // example /private/... on macOS); fall back to a workspace-relative
            // suffix match so overlay files always win their real counterparts.
            for (const [plannedFileName, content] of Object.entries(overlay)) {
              if (fileName.endsWith(Path.relative(root, plannedFileName))) return content
            }
            return undefined
          },
        },
      }
      return Effect.gen(function*() {
        const isolatedCompiler = yield* NativeCompiler
        return yield* openRegion(isolatedCompiler, [...resolvedById.values()], {}, () => {}, program)
      }).pipe(Effect.provide(nativeCompilerLayer(overlayOptions)))
    }

    return Workspace.of({ definition, root, withSnapshot, withIsolatedSnapshot })
  })

export const layerWithoutDependencies = (
  definition: WorkspaceDefinition,
  options: APIOptions = {},
): Layer.Layer<Workspace, DuplicateConfiguredProject, NativeCompiler> =>
  Layer.effect(Workspace, make(definition, options))

export const layer = (
  definition: WorkspaceDefinition,
  options: APIOptions = {},
): Layer.Layer<Workspace, DuplicateConfiguredProject> =>
  layerWithoutDependencies(definition, options).pipe(Layer.provide(nativeCompilerLayer(options)))
