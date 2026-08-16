/**
 * Application domain — the write-authority seam.
 *
 * `PlanApplication` is deliberately a separate service from `Workspace`: a
 * planning or verification runtime can omit write authority entirely, and
 * only a Verified Plan — successful Verification against an exact snapshot —
 * is accepted. Application is the sole stage that writes project files.
 */
import { Effect, FileSystem, Path } from "effect"
import {
  type ApplicationFailure,
  type ApplicationIndeterminate,
  applicationLayer,
  type ApplicationReceipt,
  PlanApplication,
  type StalePlanError,
  type VerifiedPlan,
} from "../internal/verification.ts"

export { PlanApplication }
export type { ApplicationReceipt, VerifiedPlan }

export const Application = {
  apply: (
    verified: VerifiedPlan,
  ): Effect.Effect<
    ApplicationReceipt,
    StalePlanError | ApplicationFailure | ApplicationIndeterminate,
    PlanApplication | FileSystem.FileSystem | Path.Path
  > => PlanApplication.use((application) => application.apply(verified)),
}
