/** Application domain values and write-authority service contract. */
import { Context, Data, Effect, FileSystem, Path } from "effect"
import type { VerifiedPlan } from "../Verification/Engine.ts"

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
  ) => Effect.Effect<ApplicationReceipt, import("../Verification/Engine.ts").StalePlanError | ApplicationFailure | ApplicationIndeterminate, FileSystem.FileSystem | Path.Path>
}

export class PlanApplication extends Context.Service<PlanApplication, PlanApplicationService>()(
  "@safemods/internal/PlanApplication",
) {}
