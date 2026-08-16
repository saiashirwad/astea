import { path as Path } from "../platform/node.ts"
import { Effect } from "effect"
import { applyFileEdits, type EditConflict, type InvalidEdit, type TextEdit } from "../Edit/index.ts"
import type { PlannedFileOperation } from "../internal/plan.ts"
import {
  FileNotFound,
  ProjectNotInSnapshot,
  type ProjectSnapshotError,
  type WorkspaceSnapshotService,
} from "../api/workspace.ts"

/** Materialize planned changes as an absolute-path virtual source map. */
export const materialize = (
  snapshot: WorkspaceSnapshotService,
  edits: ReadonlyArray<TextEdit>,
  fileOperations: ReadonlyArray<PlannedFileOperation> = [],
): Effect.Effect<
  Record<string, string>,
  ProjectSnapshotError | ProjectNotInSnapshot | FileNotFound | InvalidEdit | EditConflict
> => Effect.gen(function*() {
  const overlay: Record<string, string> = {}

  for (const operation of fileOperations) {
    const configured = snapshot.projects.find((project) => project.id === operation.projectId)
    if (configured === undefined) {
      return yield* new ProjectNotInSnapshot({ projectId: operation.projectId, generation: snapshot.generation })
    }
    const project = yield* snapshot.project(configured)
    const sourcePath = Path.resolve(project.root, operation.path)
    if (operation.kind === "create") {
      overlay[sourcePath] = operation.content ?? ""
    } else if (operation.kind === "delete") {
      overlay[sourcePath] = ""
    } else if (operation.toPath !== undefined) {
      const targetPath = Path.resolve(project.root, operation.toPath)
      overlay[sourcePath] = ""
      overlay[targetPath] = operation.content ?? (yield* project.sourceText(operation.path))
    }
  }

  const grouped = Map.groupBy(edits, (edit) => `${edit.projectId}\0${edit.fileName}`)
  for (const group of grouped.values()) {
    const first = group[0]!
    const configured = snapshot.projects.find((project) => project.id === first.projectId)
    if (configured === undefined) {
      return yield* new ProjectNotInSnapshot({ projectId: first.projectId, generation: snapshot.generation })
    }
    const project = yield* snapshot.project(configured)
    const source = yield* project.sourceText(first.fileName)
    overlay[Path.resolve(project.root, first.fileName)] = yield* applyFileEdits(source, group)
  }
  return overlay
})
