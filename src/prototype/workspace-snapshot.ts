/**
 * PROTOTYPE — candidate domain model for workspaces and snapshot regions.
 *
 * This tests an API shape. It is not the production public API.
 */
import * as Path from "node:path"
import { Context, Data, Effect, Layer, Semaphore } from "effect"
import type { APIOptions, Project as NativeProject } from "typescript/unstable/async"
import type { FileChanges } from "typescript/unstable/proto"
import {
  layer as nativeCompilerLayer,
  NativeCompiler,
  type NativeCompilerError,
  nativeRequest,
} from "./native-compiler.ts"

const ConfiguredProjectTypeId: unique symbol = Symbol.for("@teatime/ConfiguredProject")

export interface ConfiguredProject {
  readonly [ConfiguredProjectTypeId]: typeof ConfiguredProjectTypeId
  readonly configFileName: string
}

export const ConfiguredProject = {
  make: (configFileName: string): ConfiguredProject => {
    const project: ConfiguredProject = {
      [ConfiguredProjectTypeId]: ConfiguredProjectTypeId,
      configFileName: Path.resolve(configFileName),
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
  readonly configFileName: string
}> {}

export class ProjectNotInSnapshot extends Data.TaggedError("ProjectNotInSnapshot")<{
  readonly configFileName: string
  readonly generation: number
}> {}

export class SnapshotExpired extends Data.TaggedError("SnapshotExpired")<{
  readonly generation: number
}> {}

export type ProjectSnapshotError = NativeCompilerError | SnapshotExpired

export interface ProjectSnapshot {
  readonly project: ConfiguredProject
  readonly rootFiles: ReadonlyArray<string>
  readonly sourceFileNames: () => Effect.Effect<ReadonlyArray<string>, ProjectSnapshotError>
  readonly semanticDiagnosticCount: () => Effect.Effect<number, ProjectSnapshotError>
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
  "@teatime/prototype/WorkspaceSnapshot",
) {}

export interface WorkspaceService {
  readonly withSnapshot: <A, E, R>(
    transition: SnapshotTransition,
    program: Effect.Effect<A, E, R | WorkspaceSnapshot>,
  ) => Effect.Effect<A, E | NativeCompilerError | ProjectNotInSnapshot, Exclude<R, WorkspaceSnapshot>>
}

export class Workspace extends Context.Service<Workspace, WorkspaceService>()(
  "@teatime/prototype/Workspace",
) {}

const toNativeChanges = (changes: WorkspaceChanges | undefined): FileChanges | undefined => {
  if (changes === undefined) return undefined
  if ("invalidateAll" in changes) return { invalidateAll: true }
  return {
    ...(changes.changed === undefined ? {} : { changed: [...changes.changed] }),
    ...(changes.created === undefined ? {} : { created: [...changes.created] }),
    ...(changes.deleted === undefined ? {} : { deleted: [...changes.deleted] }),
  }
}

export const make = (
  definition: WorkspaceDefinition,
): Effect.Effect<Workspace["Service"], DuplicateConfiguredProject, NativeCompiler> => Effect.gen(function*() {
  const compiler = yield* NativeCompiler
  const transitionLock = yield* Semaphore.make(1)
  const projects = Object.freeze([...definition.projects])
  const configFileNames = new Set<string>()

  for (const project of projects) {
    if (configFileNames.has(project.configFileName)) {
      return yield* new DuplicateConfiguredProject({ configFileName: project.configFileName })
    }
    configFileNames.add(project.configFileName)
  }

  let opened = false

  const withSnapshot: WorkspaceService["withSnapshot"] = Effect.fn("Workspace.withSnapshot")(
    function*<A, E, R>(
      transition: SnapshotTransition,
      program: Effect.Effect<A, E, R | WorkspaceSnapshot>,
    ) {
      return yield* Effect.scoped(Effect.gen(function*() {
        const nativeSnapshot = yield* transitionLock.withPermit(Effect.suspend(() => {
          const openProjects = opened ? undefined : projects.map((project) => project.configFileName)
          return compiler.openSnapshot({
            ...(openProjects === undefined ? {} : { openProjects }),
            ...(transition.changes === undefined
              ? {}
              : { fileChanges: toNativeChanges(transition.changes) }),
          }).pipe(Effect.tap(() => Effect.sync(() => {
            opened = true
          })))
        }))

        const active = { current: true }
        const ensureActive = Effect.suspend((): Effect.Effect<void, SnapshotExpired> =>
          active.current
            ? Effect.void
            : Effect.fail(new SnapshotExpired({ generation: nativeSnapshot.id })))

        const project = Effect.fn("WorkspaceSnapshot.project")(function*(configured: ConfiguredProject) {
          yield* ensureActive
          const nativeProject = nativeSnapshot.getProject(configured.configFileName)
          if (nativeProject === undefined || !configFileNames.has(configured.configFileName)) {
            return yield* new ProjectNotInSnapshot({
              configFileName: configured.configFileName,
              generation: nativeSnapshot.id,
            })
          }

          const sourceFileNames = Effect.fn("ProjectSnapshot.sourceFileNames")(function*() {
            yield* ensureActive
            return yield* nativeRequest("getSourceFileNames", () => nativeProject.program.getSourceFileNames())
          })
          const semanticDiagnosticCount = Effect.fn("ProjectSnapshot.semanticDiagnosticCount")(function*() {
            yield* ensureActive
            const diagnostics = yield* nativeRequest(
              "getSemanticDiagnostics",
              () => nativeProject.program.getSemanticDiagnostics(),
            )
            return diagnostics.length
          })
          const unsafeNative: ProjectSnapshot["unsafeNative"] = (use) =>
            Effect.andThen(ensureActive, Effect.suspend(() => use(nativeProject)))

          return {
            project: configured,
            rootFiles: nativeProject.rootFiles,
            sourceFileNames,
            semanticDiagnosticCount,
            unsafeNative,
          } satisfies ProjectSnapshot
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
    },
  )

  return Workspace.of({ withSnapshot })
})

export const layerWithoutDependencies = (
  definition: WorkspaceDefinition,
): Layer.Layer<Workspace, DuplicateConfiguredProject, NativeCompiler> =>
  Layer.effect(Workspace, make(definition))

export const layer = (
  definition: WorkspaceDefinition,
  options: APIOptions,
): Layer.Layer<Workspace, DuplicateConfiguredProject> =>
  layerWithoutDependencies(definition).pipe(Layer.provide(nativeCompilerLayer(options)))
