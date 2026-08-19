/** Application domain values and write-authority service contract. */
import { Context, Data, type Effect, type FileSystem, type Path } from "effect"
import type {
  ProjectIdentityMismatch,
  StalePlanError,
  VerifiedPlan,
} from "../Verification/Engine.ts"

export class ApplicationFailure extends Data.TaggedError("ApplicationFailure")<{
  readonly planId: string
  readonly cause: unknown
  readonly rolledBack: boolean
}> {}

export class ApplicationIndeterminate extends Data.TaggedError("ApplicationIndeterminate")<{
  readonly planId: string
  readonly cause: unknown
  readonly rollbackCause: unknown
}> {}

export interface ApplicationReceipt {
  readonly planId: string
  readonly snapshotHash: string
  readonly outputs: ReadonlyArray<{
    readonly projectId: string
    readonly fileName: string
    readonly hash: string
  }>
}

export interface PlanApplicationService {
  readonly apply: (
    verified: VerifiedPlan,
  ) => Effect.Effect<
    ApplicationReceipt,
    StalePlanError | ApplicationFailure | ApplicationIndeterminate | ProjectIdentityMismatch,
    FileSystem.FileSystem | Path.Path
  >
}

export class PlanApplication extends Context.Service<PlanApplication, PlanApplicationService>()(
  // oxlint-disable-next-line effecttsgo/deterministic-keys -- Stable public service identifier.
  "@safemods/internal/PlanApplication",
) {}
