import { Effect, Layer, Semaphore, type FileSystem, type Path } from "effect"
import { PlanApplication } from "../../Application/Application.ts"
import { Workspace } from "../../Workspace/index.ts"
import { layer as nodeLayer } from "../../platform/node.ts"
import { applyVerifiedPlan } from "./Transaction.ts"

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
): Layer.Layer<PlanApplication | FileSystem.FileSystem | Path.Path, never, Workspace> =>
  Layer.merge(applicationLayer(workspaceRoot), nodeLayer)

/**
 * The service-only layer is intentionally exported from this module (but not
 * the public Node barrel) so failure-injection tests can provide a controlled
 * FileSystem implementation.
 */
export const applicationLayer = (
  workspaceRoot: string,
): Layer.Layer<PlanApplication, never, Workspace> =>
  Layer.effect(
    PlanApplication,
    Workspace.use((workspace) =>
      Effect.gen(function* () {
        const mutex = yield* Semaphore.make(1)
        return PlanApplication.of({
          apply: (verified) =>
            mutex.withPermit(applyVerifiedPlan(workspaceRoot, workspace.definition)(verified)),
        })
      }),
    ),
  )
