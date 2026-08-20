/** Sequential Draft composition: overlay, then rebase onto the original snapshot. */
import { Effect } from "effect"
import type { Draft } from "../Draft/index.ts"
import type { EditConflict, InvalidEdit } from "../Edit/index.ts"
import type { DraftEvidenceConflict } from "../Evidence/index.ts"
import type { VirtualFsError } from "../VirtualFs/index.ts"
import {
  WorkspaceSnapshot,
  type FileNotFound,
  type ProjectNotInSnapshot,
  type ProjectSnapshotError,
  type Workspace,
} from "../Workspace/index.ts"
import { rebaseDrafts, requireDraftProjects } from "./Rebase.ts"
import { run } from "./Run.ts"

/**
 * Materialize `accumulated`, run `program` against that isolated snapshot, and
 * rebase the resulting Draft onto the original snapshot.
 *
 * `program` must return the next Draft. This module does not inspect the
 * result to guess a Draft. Use `run` when the program only queries the overlay
 * or returns something other than a Draft.
 */
export const composeDraft = <E, R>(
  accumulated: Draft,
  program: Effect.Effect<Draft, E, R | WorkspaceSnapshot>,
): Effect.Effect<
  Draft,
  | E
  | ProjectSnapshotError
  | ProjectNotInSnapshot
  | FileNotFound
  | InvalidEdit
  | EditConflict
  | VirtualFsError
  | DraftEvidenceConflict,
  Workspace | WorkspaceSnapshot | Exclude<R, WorkspaceSnapshot>
> =>
  Effect.gen(function* () {
    const snapshot = yield* WorkspaceSnapshot
    yield* requireDraftProjects(snapshot, accumulated)
    const next = yield* run(accumulated, program)
    return yield* rebaseDrafts(snapshot, accumulated, next)
  })
