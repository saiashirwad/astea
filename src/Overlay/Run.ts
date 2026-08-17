import { Effect } from "effect"
import type { EditConflict, InvalidEdit, TextEdit } from "../Edit/index.ts"
import type { PlannedFileOperation } from "../Plan/index.ts"
import {
  type FileNotFound,
  type ProjectNotInSnapshot,
  type ProjectSnapshotError,
  Workspace,
  WorkspaceSnapshot,
} from "../Workspace/index.ts"
import { materialize } from "./Materialize.ts"
import type { VirtualFsError } from "../VirtualFs/index.ts"

export const run = <A, E, R>(
  planOrDraft: {
    readonly edits: ReadonlyArray<TextEdit>
    readonly fileOperations?: ReadonlyArray<PlannedFileOperation>
  },
  program: Effect.Effect<A, E, R | WorkspaceSnapshot>,
): Effect.Effect<
  A,
  | E
  | ProjectSnapshotError
  | ProjectNotInSnapshot
  | FileNotFound
  | InvalidEdit
  | EditConflict
  | VirtualFsError,
  Workspace | WorkspaceSnapshot | Exclude<R, WorkspaceSnapshot>
> =>
  Effect.gen(function* () {
    const workspace = yield* Workspace
    const snapshot = yield* WorkspaceSnapshot
    const sourceMap = yield* materialize(
      snapshot,
      planOrDraft.edits,
      planOrDraft.fileOperations ?? [],
    )
    return yield* workspace.withIsolatedSnapshot(sourceMap, program)
  })
