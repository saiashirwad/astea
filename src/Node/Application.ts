import { Effect, FileSystem, Layer, Path } from "effect"
import {
  applicationLayer,
  PlanApplication,
} from "../internal/verification.ts"
import { Workspace } from "../Workspace/index.ts"
import { layer as nodeLayer } from "../platform/node.ts"

/** Node filesystem implementation of the sole write-authority service. */
export const applicationLayerNode: Layer.Layer<
  PlanApplication | FileSystem.FileSystem | Path.Path,
  never,
  Workspace
> = Layer.unwrap(
  Workspace.use((workspace) => Effect.succeed(makeApplicationLayerNode(workspace.root))),
)

/** Node-backed application service without leaking filesystem authority upward. */
export const makeApplicationLayerNode = (
  workspaceRoot: string,
): Layer.Layer<PlanApplication | FileSystem.FileSystem | Path.Path> =>
  Layer.merge(applicationLayer(workspaceRoot), nodeLayer)
