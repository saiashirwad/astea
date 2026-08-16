import { Effect } from "effect"
import type { EditConflict, InvalidEdit, TextEdit } from "../Edit/index.ts"
import type { PlannedFileOperation } from "../internal/plan.ts"
import {
  type FileNotFound,
  type ProjectNotInSnapshot,
  type ProjectSnapshotError,
  Workspace,
  WorkspaceSnapshot,
} from "../api/workspace.ts"
import { materialize } from "./Materialize.ts"

export const run = <A, E, R>(
  planOrDraft: {
    readonly edits: ReadonlyArray<TextEdit>
    readonly fileOperations?: ReadonlyArray<PlannedFileOperation>
  },
  program: Effect.Effect<A, E, R | WorkspaceSnapshot>,
): Effect.Effect<
  A,
  E | ProjectSnapshotError | ProjectNotInSnapshot | FileNotFound | InvalidEdit | EditConflict,
  Workspace | WorkspaceSnapshot | Exclude<R, WorkspaceSnapshot>
> => Effect.gen(function*() {
  const workspace = yield* Workspace
  const snapshot = yield* WorkspaceSnapshot
  const sourceMap = yield* materialize(snapshot, planOrDraft.edits, planOrDraft.fileOperations ?? [])
  return yield* workspace.withIsolatedSnapshot(sourceMap, program)
})
