/** Verification failures at plan, recipe, policy, and workspace boundaries. */
import { Data } from "effect"
import type { Json } from "../Evidence/index.ts"
import type { TransformationPlan } from "../Plan/index.ts"
import type { DiagnosticRecord } from "../Policy/index.ts"

export class StalePlanError extends Data.TaggedError("StalePlanError")<{
  readonly planId: string
  readonly projectId: string
  readonly fileName: string
}> {}

export class VerificationFailure extends Data.TaggedError("VerificationFailure")<{
  readonly planId: string
  readonly policy: "edits" | "matches" | "affected-files" | "diagnostics" | "idempotence"
  readonly detail: string
  /** Diagnostics relevant to the failed policy, including source locations. */
  readonly diagnostics?: ReadonlyArray<DiagnosticRecord> | undefined
}> {}

/** A plan's project identities are not the live Workspace definition. */
export class ProjectIdentityMismatch extends Data.TaggedError("ProjectIdentityMismatch")<{
  readonly planId: string
  readonly expected: ReadonlyArray<{ readonly id: string; readonly config: string }>
  readonly actual: ReadonlyArray<{ readonly id: string; readonly config: string }>
}> {}

/** The supplied recipe is not the recipe that authored the durable plan. */
export class RecipeMismatch extends Data.TaggedError("RecipeMismatch")<{
  readonly planId: string
  readonly expected: {
    readonly name: string
    readonly version: string
    readonly implementationHash: string
  }
  readonly actual: {
    readonly name: string
    readonly version: string
    readonly implementationHash: string
  }
}> {}

/** The supplied recipe input does not match the canonical input in the plan. */
export class RecipeInputMismatch extends Data.TaggedError("RecipeInputMismatch")<{
  readonly planId: string
  readonly expected: Json
  readonly actual: Json
}> {}

/** The running toolchain is not the one that authored the durable plan. */
export class ToolchainMismatch extends Data.TaggedError("ToolchainMismatch")<{
  readonly planId: string
  readonly expected: TransformationPlan["toolchain"]
  readonly actual: TransformationPlan["toolchain"]
}> {}

/** The supplied recipe's durable policies differ from those in the plan. */
export class PolicyMismatch extends Data.TaggedError("PolicyMismatch")<{
  readonly planId: string
  readonly expected: TransformationPlan["policies"]
  readonly actual: TransformationPlan["policies"]
}> {}
