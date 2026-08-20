import { Effect } from "effect"
import type { EditConflict, InvalidEdit, TextEdit } from "../Edit/index.ts"
import type { PlannedFileOperation } from "../Plan/index.ts"
import {
  materialize as materializeVirtualFs,
  type VirtualFsError,
  type VirtualFsSnapshot,
} from "../VirtualFs/index.ts"
import {
  ProjectNotInSnapshot,
  type FileNotFound,
  type ProjectSnapshot,
  type ProjectSnapshotError,
  type WorkspaceSnapshotService,
} from "../Workspace/index.ts"

/**
 * Materialize changes against one coherent virtual filesystem.
 *
 * The return value is a VirtualFsSnapshot. Absolute-path indexing is retained
 * as a compatibility view for callers of the pre-Phase-1 Overlay API.
 */
export const materialize = (
  snapshot: WorkspaceSnapshotService,
  edits: ReadonlyArray<TextEdit>,
  fileOperations: ReadonlyArray<PlannedFileOperation> = [],
): Effect.Effect<
  VirtualFsSnapshot & Readonly<Record<string, string>>,
  | ProjectSnapshotError
  | ProjectNotInSnapshot
  | FileNotFound
  | InvalidEdit
  | EditConflict
  | VirtualFsError
> =>
  Effect.gen(function* () {
    const projects = new Map<string, WorkspaceSnapshotService["projects"][number]>()
    const snapshots = new Map<string, ProjectSnapshot>()

    const projectFor = (projectId: string) => {
      const configured =
        projects.get(projectId) ?? snapshot.projects.find((project) => project.id === projectId)
      if (configured === undefined) {
        return Effect.fail(new ProjectNotInSnapshot({ projectId, generation: snapshot.generation }))
      }
      projects.set(projectId, configured)
      return Effect.map(snapshot.project(configured), (project) => {
        snapshots.set(projectId, project)
        return project
      })
    }

    for (const project of snapshot.projects) {
      yield* projectFor(project.id)
    }

    const projectForPath = (projectId: string): ProjectSnapshot => {
      const project = snapshots.get(projectId)
      if (project === undefined) {
        // Every path is resolved after its project is loaded by the canonical
        // engine; this is an invariant violation if it ever occurs.
        throw new Error(`Project ${projectId} was not loaded before path resolution`)
      }
      return project
    }

    const result = yield* materializeVirtualFs({
      edits,
      fileOperations,
      load: (projectId, fileName) =>
        Effect.gen(function* () {
          const project = snapshots.get(projectId) ?? (yield* projectFor(projectId))
          return yield* project.sourceText(fileName)
        }),
      resolvePath: (projectId, fileName) => projectForPath(projectId).resolveFileName(fileName),
    })

    // A non-symbol compatibility view keeps older Overlay.materialize users
    // working without making lifecycle state implicit again.
    return Object.assign(Object.fromEntries(result.files), result)
  })
