/** Pure evaluation of durable policies and runtime verification rules. */
import type { PlanPolicies } from "../Plan/index.ts"
import {
  type AllowedError,
  type DiagnosticDiff,
  type DiagnosticRecord,
  type PolicyEvaluationContext,
  type VerificationRule,
  unpermittedIntroducedErrors,
} from "../Policy/index.ts"

export interface PolicyResult {
  readonly name: string
  readonly passed: boolean
  readonly detail?: string
}

export interface PolicyFailure {
  readonly policy: "matches" | "affected-files" | "diagnostics" | "idempotence"
  readonly detail: string
  readonly diagnostics?: ReadonlyArray<DiagnosticRecord> | undefined
}

export interface BuiltInPolicyInput {
  readonly policies: PlanPolicies
  readonly actualMatches?: number | undefined
  readonly affectedFiles: number
  readonly baselineErrorCount: number
  readonly proposedErrorCount: number
  readonly diagnosticDiff: DiagnosticDiff
  readonly secondPlanChangeCount?: number | undefined
  readonly allowedErrors?: ReadonlyArray<AllowedError> | undefined
}

export interface PolicyEvaluation {
  readonly results: ReadonlyArray<PolicyResult>
  readonly failure?: PolicyFailure | undefined
  readonly missingMatchMeasurement: boolean
}

export interface CustomPolicyEvaluation {
  readonly results: ReadonlyArray<PolicyResult>
  readonly failure?: PolicyFailure | undefined
}

/** Evaluate every durable built-in policy in its established order. */
export const evaluateBuiltInPolicies = (input: BuiltInPolicyInput): PolicyEvaluation => {
  const results: Array<PolicyResult> = []
  const { min, max } = input.policies.matchCount
  const hasMatchBounds = min !== undefined || max !== undefined
  const missingMatchMeasurement = hasMatchBounds && input.actualMatches === undefined
  const matchesPassed =
    !missingMatchMeasurement &&
    (min === undefined || input.actualMatches! >= min) &&
    (max === undefined || input.actualMatches! <= max)

  if (hasMatchBounds) results.push({ name: "match-count", passed: matchesPassed })

  const affectedFilesPassed =
    input.policies.maxAffectedFiles === undefined ||
    input.affectedFiles <= input.policies.maxAffectedFiles
  if (input.policies.maxAffectedFiles !== undefined) {
    results.push({ name: "affected-files", passed: affectedFilesPassed })
  }

  const unpermittedErrors = unpermittedIntroducedErrors(
    input.diagnosticDiff,
    input.allowedErrors ?? [],
  )
  const diagnosticsPassed =
    input.policies.diagnostics !== "no-new-errors" || unpermittedErrors.length === 0
  results.push({
    name: input.policies.diagnostics === "no-new-errors" ? "no-new-errors" : "diagnostic-diff",
    passed: diagnosticsPassed,
  })

  const idempotencePassed =
    input.policies.idempotence !== "required" || input.secondPlanChangeCount === 0
  if (input.policies.idempotence === "required") {
    results.push({ name: "idempotence", passed: idempotencePassed })
  }

  let failure: PolicyFailure | undefined
  if (missingMatchMeasurement) {
    failure = {
      policy: "matches",
      detail: "Plan carries no primary-run match measurement",
    }
  } else if (!matchesPassed) {
    failure = { policy: "matches", detail: `Observed ${input.actualMatches}` }
  } else if (!affectedFilesPassed) {
    failure = { policy: "affected-files", detail: `Observed ${input.affectedFiles}` }
  } else if (!diagnosticsPassed) {
    failure = {
      policy: "diagnostics",
      detail: `Introduced ${unpermittedErrors.length} new error diagnostic(s): ${unpermittedErrors.map((error) => `TS${error.code}: ${error.message}`).join("; ")}`,
      diagnostics: unpermittedErrors,
    }
  } else if (!idempotencePassed) {
    failure = { policy: "idempotence", detail: "Second recipe run was not empty" }
  }

  return { results, failure, missingMatchMeasurement }
}

/** Evaluate custom rules in declaration order and stop at the first failure. */
export const evaluateCustomRules = (
  rules: ReadonlyArray<VerificationRule>,
  context: PolicyEvaluationContext,
): CustomPolicyEvaluation => {
  const results: Array<PolicyResult> = []
  for (const rule of rules) {
    const result = rule.evaluate(context)
    if (result === true) {
      results.push({ name: rule.name, passed: true })
      continue
    }
    const detail = result === false ? `Policy rule '${rule.name}' failed` : result
    results.push({ name: rule.name, passed: false, detail })
    return {
      results,
      failure: {
        policy: "diagnostics",
        detail,
        diagnostics: context.diagnosticDiff.introduced,
      },
    }
  }
  return { results }
}

/** Convert a reported failed result into the defensive verification failure. */
export const failureFromPolicyResults = (
  results: ReadonlyArray<PolicyResult> | undefined,
  diagnosticDiff: DiagnosticDiff,
): PolicyFailure | undefined => {
  const failed = results?.find((result) => !result.passed)
  if (failed === undefined) return undefined
  return {
    policy:
      failed.name === "idempotence"
        ? "idempotence"
        : failed.name === "match-count"
          ? "matches"
          : failed.name === "affected-files"
            ? "affected-files"
            : "diagnostics",
    detail: failed.detail ?? `Policy '${failed.name}' failed`,
    diagnostics: diagnosticDiff.introduced,
  }
}
