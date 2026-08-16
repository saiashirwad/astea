/**
 * Candidate public API — Application, the write-authority seam.
 *
 * `PlanApplication` is deliberately a separate service from `Workspace`: a
 * planning or verification runtime can omit write authority entirely, and
 * only a Verified Plan — successful Verification against an exact snapshot —
 * is accepted. Application is the sole stage that writes project files.
 */
import { Effect, Layer } from "effect"
import { layer as nodeLayer } from "../platform/node.ts"
import {
  type ApplicationFailure,
  type ApplicationIndeterminate,
  applicationLayer,
  type ApplicationReceipt,
  PlanApplication,
  type StalePlanError,
  type VerifiedPlan,
} from "../internal/verification.ts"
import { Workspace } from "../Workspace/index.ts"

export { PlanApplication }
export type { ApplicationReceipt, VerifiedPlan }

/**
 * Production filesystem adapter: staged same-filesystem writes, atomic
 * per-file rename, confirmed output hashes, and rollback on handled failure.
 * Reads the workspace root from the ambient `Workspace`.
 */
export const layerNode: Layer.Layer<PlanApplication, never, Workspace> = Layer.unwrap(
  Workspace.use((workspace) => Effect.succeed(applicationLayer(workspace.root))),
)

export const Application = {
  apply: (
    verified: VerifiedPlan,
  ): Effect.Effect<
    ApplicationReceipt,
    StalePlanError | ApplicationFailure | ApplicationIndeterminate,
    PlanApplication
  > => PlanApplication.use((application) => application.apply(verified).pipe(Effect.provide(nodeLayer))),
}
