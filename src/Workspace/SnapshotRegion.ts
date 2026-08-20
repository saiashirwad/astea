/** Snapshot-region lifetime and service provisioning. */
import { Context, Effect } from "effect"
import type { FileChanges } from "typescript/unstable/proto"
import type { NativeCompiler, WorkspaceCompilerError } from "./internal/NativeCompiler.ts"
import {
  type ConfiguredProject,
  type ProjectSnapshot,
  ProjectNotInSnapshot,
  type SnapshotTransition,
  SnapshotExpired,
  type WorkspaceChanges,
} from "./Model.ts"
import { projectSnapshotFor } from "./ProjectSnapshot.ts"
import type { WorkspaceRuntimeService } from "./Runtime.ts"

export interface WorkspaceSnapshotService {
  readonly generation: number
  readonly projects: ReadonlyArray<ConfiguredProject>
  readonly project: (
    project: ConfiguredProject,
  ) => Effect.Effect<ProjectSnapshot, ProjectNotInSnapshot | SnapshotExpired>
}

export class WorkspaceSnapshot extends Context.Service<
  WorkspaceSnapshot,
  WorkspaceSnapshotService
>()(
  // oxlint-disable-next-line effecttsgo/deterministic-keys -- Stable public service identifier.
  "@safemods/WorkspaceSnapshot",
) {}

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
  if (changes.changed !== undefined) result.changed = [...changes.changed]
  if (changes.created !== undefined) result.created = [...changes.created]
  if (changes.deleted !== undefined) result.deleted = [...changes.deleted]
  return result
}

export interface OpenSnapshotRegionOptions {
  readonly regionCompiler: NativeCompiler["Service"]
  readonly projects: ReadonlyArray<ConfiguredProject>
  readonly resolvedById: ReadonlyMap<string, string>
  readonly openProjects: ReadonlyArray<string> | undefined
  readonly transition: SnapshotTransition
  readonly onOpened: () => void
  readonly runtime: WorkspaceRuntimeService
}

/** Open one native snapshot and expire all its native values after the program. */
export const openSnapshotRegion = <A, E, R>(
  options: OpenSnapshotRegionOptions,
  program: Effect.Effect<A, E, R | WorkspaceSnapshot>,
): Effect.Effect<A, E | WorkspaceCompilerError, Exclude<R, WorkspaceSnapshot>> =>
  Effect.scoped(
    Effect.gen(function* () {
      const params: OpenSnapshotParams = {}
      if (options.openProjects !== undefined) {
        params.openProjects = [...options.openProjects]
      }
      if (options.transition.changes !== undefined) {
        const fileChanges = toNativeChanges(options.transition.changes)
        if (fileChanges !== undefined) params.fileChanges = fileChanges
      }
      const nativeSnapshot = yield* options.regionCompiler
        .openSnapshot(params)
        .pipe(Effect.tap(() => Effect.sync(options.onOpened)))

      const active = { current: true }
      const ensureActive = Effect.suspend((): Effect.Effect<void, SnapshotExpired> =>
        active.current
          ? Effect.void
          : Effect.fail(new SnapshotExpired({ generation: nativeSnapshot.id })),
      )

      const project = Effect.fn("WorkspaceSnapshot.project")(function* (
        configured: ConfiguredProject,
      ) {
        yield* ensureActive
        const configFileName = options.resolvedById.get(configured.id)
        const nativeProject =
          configFileName === undefined ? undefined : nativeSnapshot.getProject(configFileName)
        if (configFileName === undefined || nativeProject === undefined) {
          return yield* new ProjectNotInSnapshot({
            projectId: configured.id,
            generation: nativeSnapshot.id,
          })
        }

        return projectSnapshotFor({
          configured,
          nativeProject,
          projectRoot: options.runtime.dirname(configFileName),
          ensureActive,
          runtime: options.runtime,
        })
      })

      const snapshotService = WorkspaceSnapshot.of({
        generation: nativeSnapshot.id,
        projects: options.projects,
        project,
      })

      return yield* program.pipe(
        Effect.provideService(WorkspaceSnapshot, snapshotService),
        Effect.ensuring(
          Effect.sync(() => {
            active.current = false
          }),
        ),
      )
    }),
  )
