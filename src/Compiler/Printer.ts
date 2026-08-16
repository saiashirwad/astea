import { Effect } from "effect"
import type { Node } from "typescript/unstable/ast"
import type { SnapshotExpired, ProjectSnapshot } from "../api/workspace.ts"
import { nativeRequest, type NativeCompilerError } from "../internal/native-compiler.ts"

/** Print an AST fragment through the snapshot's native TypeScript emitter. */
export const printNativeFragment = (
  project: ProjectSnapshot,
  node: Node,
): Effect.Effect<string, NativeCompilerError | SnapshotExpired> =>
  project.unsafeNative((nativeProject) =>
    nativeRequest("print native fragment", () => nativeProject.emitter.printNode(node)))
