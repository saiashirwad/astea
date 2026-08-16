import { path as Path } from "../platform/node.ts"
import { Effect } from "effect"
import {
  applyFileEdits,
  type EditConflict,
  type InvalidEdit,
  type TextEdit,
} from "../Edit/index.ts"
import type { PlannedFileOperation } from "../Plan/index.ts"
import {
  FileNotFound,
  ProjectNotInSnapshot,
  type ProjectSnapshot,
  type ProjectSnapshotError,
  type WorkspaceSnapshotService,
} from "../Workspace/index.ts"

// SAFETY: these process-local symbols match the Workspace virtual-FS adapter.
const VIRTUAL_CREATED: unique symbol = Symbol.for("@safemods/Overlay/virtual-created") as never
const VIRTUAL_DELETED: unique symbol = Symbol.for("@safemods/Overlay/virtual-deleted") as never

type Overlay = Record<string, string> & {
  readonly [VIRTUAL_CREATED]?: ReadonlySet<string>
  readonly [VIRTUAL_DELETED]?: ReadonlySet<string>
}

interface VirtualFile {
  readonly projectId: string
  readonly fileName: string
  content: string
  exists: boolean
}

/**
 * Materialize changes against one coherent virtual filesystem.
 *
 * Operations are applied to the virtual state before edits.  This gives a
 * later edit access to a newly-created or moved file, while a delete remains
 * terminal and cannot be accidentally resurrected by an edit that was
 * authored against an earlier stage.
 */
export const materialize = (
  snapshot: WorkspaceSnapshotService,
  edits: ReadonlyArray<TextEdit>,
  fileOperations: ReadonlyArray<PlannedFileOperation> = [],
): Effect.Effect<
  Readonly<Record<string, string>>,
  ProjectSnapshotError | ProjectNotInSnapshot | FileNotFound | InvalidEdit | EditConflict
> =>
  Effect.gen(function* () {
    const state = new Map<string, VirtualFile>()
    const projects = new Map<string, WorkspaceSnapshotService["projects"][number]>()
    const snapshots = new Map<string, ProjectSnapshot>()
    const deleted = new Set<string>()
    const created = new Set<string>()

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

    const key = (projectId: string, fileName: string) => `${projectId}\0${fileName}`
    const absolute = (_projectId: string, fileName: string, projectRoot: string) =>
      Path.resolve(projectRoot, fileName)

    const load = (
      projectId: string,
      fileName: string,
    ): Effect.Effect<VirtualFile, ProjectSnapshotError | ProjectNotInSnapshot | FileNotFound> =>
      Effect.gen(function* () {
        const existing = state.get(key(projectId, fileName))
        if (existing !== undefined) return existing
        const project = snapshots.get(projectId) ?? (yield* projectFor(projectId))
        const content = yield* project.sourceText(fileName)
        const value: VirtualFile = { projectId, fileName, content, exists: true }
        state.set(key(projectId, fileName), value)
        return value
      })

    // Resolve operation paths and update the virtual state in declaration
    // order.  `content` takes precedence for moves because Draft.files.move
    // captures the source content from the stage in which it was authored.
    for (const operation of fileOperations) {
      const project = snapshots.get(operation.projectId) ?? (yield* projectFor(operation.projectId))
      const sourcePath = absolute(operation.projectId, operation.path, project.root)
      const sourceKey = key(operation.projectId, operation.path)
      if (operation.kind === "create") {
        state.set(sourceKey, {
          projectId: operation.projectId,
          fileName: operation.path,
          content: operation.content ?? "",
          exists: true,
        })
        deleted.delete(sourcePath)
        created.add(sourcePath)
      } else if (operation.kind === "delete") {
        const current = state.get(sourceKey)
        if (current !== undefined) current.exists = false
        else
          state.set(sourceKey, {
            projectId: operation.projectId,
            fileName: operation.path,
            content: "",
            exists: false,
          })
        deleted.add(sourcePath)
        created.delete(sourcePath)
      } else if (operation.toPath !== undefined) {
        const current = yield* load(operation.projectId, operation.path).pipe(
          Effect.catchTag("FileNotFound", () =>
            Effect.succeed({
              projectId: operation.projectId,
              fileName: operation.path,
              content: "",
              exists: false,
            }),
          ),
        )
        const targetKey = key(operation.projectId, operation.toPath)
        const targetPath = absolute(operation.projectId, operation.toPath, project.root)
        current.exists = false
        state.set(targetKey, {
          projectId: operation.projectId,
          fileName: operation.toPath,
          content: operation.content ?? current.content,
          exists: true,
        })
        deleted.add(sourcePath)
        deleted.delete(targetPath)
        created.add(targetPath)
      }
    }

    const grouped = Map.groupBy(edits, (edit) => key(edit.projectId, edit.fileName))
    for (const group of grouped.values()) {
      const first = group[0]!
      const current = yield* load(first.projectId, first.fileName)
      // A deletion wins over any earlier edit to that path.  In particular,
      // this prevents edit -> delete pipelines from reintroducing the file.
      if (!current.exists) continue
      current.content = yield* applyFileEdits(current.content, group)
    }

    const overlay: Overlay = {}
    for (const value of state.values()) {
      const project = snapshots.get(value.projectId) ?? (yield* projectFor(value.projectId))
      const filePath = absolute(value.projectId, value.fileName, project.root)
      if (value.exists) overlay[filePath] = value.content
      else deleted.add(filePath)
    }
    Object.defineProperty(overlay, VIRTUAL_DELETED, { value: deleted })
    Object.defineProperty(overlay, VIRTUAL_CREATED, { value: created })
    return overlay
  })
