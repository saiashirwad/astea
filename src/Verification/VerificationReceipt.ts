/** Durable verification outcomes and the observations that produce them. */
import type { AllowedError, DiagnosticDiff } from "../Policy/index.ts"
import type { PolicyResult } from "./PolicyEvaluation.ts"

export interface VerificationObservation {
  readonly actualMatches: number
  readonly baselineErrorCount: number
  readonly proposedErrorCount: number
  readonly secondPlanChangeCount?: number
  readonly diagnosticDiff: DiagnosticDiff
  readonly policyResults?: ReadonlyArray<PolicyResult>
  readonly allowedErrors?: ReadonlyArray<AllowedError>
}

export interface VerificationReceipt {
  readonly planId: string
  readonly snapshotHash: string
  readonly affectedFiles: number
  readonly actualMatches: number
  readonly baselineErrorCount: number
  readonly proposedErrorCount: number
  readonly diagnosticDelta: number
  readonly idempotenceChecked: boolean
  readonly policyResults: ReadonlyArray<PolicyResult>
}
