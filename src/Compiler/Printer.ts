import type { Effect } from "effect"
import type { Node } from "typescript/unstable/ast"
import type { SnapshotExpired, ProjectSnapshot } from "../Workspace/index.ts"
import { nativeRequest, type NativeCompilerError } from "./Service.ts"

/** Print an AST fragment through the snapshot's native TypeScript emitter. */
export const printNativeFragment = (
  project: ProjectSnapshot,
  node: Node,
): Effect.Effect<string, NativeCompilerError | SnapshotExpired> =>
  project.unsafeNative((nativeProject) =>
    nativeRequest("print native fragment", () => nativeProject.emitter.printNode(node)),
  )
