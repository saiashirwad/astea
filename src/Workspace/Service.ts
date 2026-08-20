/** Workspace service orchestration and layer construction. */
import { path as Path } from "../platform/node.ts"
import { Context, Effect, Layer, Semaphore } from "effect"
import type { APIOptions } from "typescript/unstable/async"
import {
  layer as nativeCompilerLayer,
  NativeCompiler,
  type NativeCompilerError,
} from "../Compiler/Service.ts"
import { resolveProjectRelativeFile } from "../Node/ProjectPath.ts"
import { InvalidProjectRelativePath } from "../ProjectPath/index.ts"
import type { VirtualFsSnapshot } from "../VirtualFs/index.ts"
import {
  DuplicateConfiguredProject,
  type ProjectNotInSnapshot,
  type SnapshotTransition,
  type WorkspaceDefinition,
} from "./Model.ts"
import { type WorkspaceSnapshot, openSnapshotRegion } from "./SnapshotRegion.ts"
import { compilerOverlayFor } from "./internal/CompilerOverlay.ts"
import {
  attachInputObserver,
  inputObserverOf,
  type CompilerObservation,
} from "./internal/ObservedInputs.ts"

export interface WorkspaceService {
  readonly definition: WorkspaceDefinition
  /** Absolute workspace root. Runtime configuration, not durable identity. */
  readonly root: string
  readonly withSnapshot: <A, E, R>(
    transition: SnapshotTransition,
    program: Effect.Effect<A, E, R | WorkspaceSnapshot>,
  ) => Effect.Effect<
    A,
    E | NativeCompilerError | ProjectNotInSnapshot,
    Exclude<R, WorkspaceSnapshot>
  >
  /** Run a program against a fresh compiler over a read-only virtual filesystem. */
  readonly withIsolatedSnapshot: <A, E, R>(
    overlay: VirtualFsSnapshot,
    program: Effect.Effect<A, E, R | WorkspaceSnapshot>,
  ) => Effect.Effect<
    A,
    E | NativeCompilerError | ProjectNotInSnapshot,
    Exclude<R, WorkspaceSnapshot>
  >
  readonly compilerObservations: () => ReadonlyArray<CompilerObservation>
}

export class Workspace extends Context.Service<Workspace, WorkspaceService>()(
  // oxlint-disable-next-line effecttsgo/deterministic-keys -- Stable public service identifier.
  "@safemods/Workspace",
) {
  static readonly layerWithoutDependencies = (
    definition: WorkspaceDefinition,
    options: APIOptions = {},
  ): Layer.Layer<
    Workspace,
    DuplicateConfiguredProject | InvalidProjectRelativePath,
    NativeCompiler
  > => layerWithoutDependencies(definition, options)

  static readonly layer = (
    definition: WorkspaceDefinition,
    options: APIOptions = {},
  ): Layer.Layer<Workspace, DuplicateConfiguredProject | InvalidProjectRelativePath> =>
    layer(definition, options)
}

export const make = (
  definition: WorkspaceDefinition,
  apiOptions: APIOptions,
): Effect.Effect<
  Workspace["Service"],
  DuplicateConfiguredProject | InvalidProjectRelativePath,
  NativeCompiler
> =>
  Effect.gen(function* () {
    const compiler = yield* NativeCompiler
    const transitionLock = yield* Semaphore.make(1)
    const root = Path.resolve(apiOptions.cwd ?? ".")
    const inputObserver = inputObserverOf(apiOptions.fs)

    const projects = Object.freeze([...definition.projects])
    const resolvedById = new Map<string, string>()
    for (const project of projects) {
      const configFileName = resolveProjectRelativeFile(root, project.config)
      if (configFileName === undefined) {
        return yield* new InvalidProjectRelativePath({ path: project.config })
      }
      if (resolvedById.has(project.id) || [...resolvedById.values()].includes(configFileName)) {
        return yield* new DuplicateConfiguredProject({ id: project.id, configFileName })
      }
      resolvedById.set(project.id, configFileName)
    }

    let opened = false

    const withSnapshot: WorkspaceService["withSnapshot"] = (transition, program) =>
      transitionLock.withPermit(
        Effect.suspend(() => {
          inputObserver?.reset()
          const openProjects = opened ? undefined : [...resolvedById.values()]
          return openSnapshotRegion(
            {
              regionCompiler: compiler,
              projects,
              resolvedById,
              openProjects,
              transition,
              onOpened: () => {
                opened = true
              },
            },
            program,
          )
        }),
      )

    const withIsolatedSnapshot: WorkspaceService["withIsolatedSnapshot"] = (overlay, program) => {
      const isolated = compilerOverlayFor(root, apiOptions, overlay)
      return Effect.gen(function* () {
        const isolatedCompiler = yield* NativeCompiler
        return yield* openSnapshotRegion(
          {
            regionCompiler: isolatedCompiler,
            projects,
            resolvedById,
            openProjects: [...resolvedById.values()],
            transition: isolated.transition,
            onOpened: () => {},
          },
          program,
        )
      }).pipe(Effect.provide(nativeCompilerLayer(isolated.options)))
    }

    return Workspace.of({
      definition,
      root,
      withSnapshot,
      withIsolatedSnapshot,
      compilerObservations: () => inputObserver?.snapshot() ?? [],
    })
  })

export const layerWithoutDependencies = (
  definition: WorkspaceDefinition,
  options: APIOptions = {},
): Layer.Layer<
  Workspace,
  DuplicateConfiguredProject | InvalidProjectRelativePath,
  NativeCompiler
> => Layer.effect(Workspace, make(definition, options))

export const layer = (
  definition: WorkspaceDefinition,
  options: APIOptions = {},
): Layer.Layer<Workspace, DuplicateConfiguredProject | InvalidProjectRelativePath> => {
  const observed = attachInputObserver(options)
  return layerWithoutDependencies(definition, observed).pipe(
    Layer.provide(nativeCompilerLayer(observed)),
  )
}
