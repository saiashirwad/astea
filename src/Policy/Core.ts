/**
 * Policy domain — durable policies and runtime verification rules.
 *
 * Policies are plain values: explicit, inspectable conditions a particular
 * Transformation Plan must satisfy to verify or apply. They compose by
 * merging; unset dimensions fall back to the system defaults (no new error
 * diagnostics, unbounded cardinality, idempotence not promised).
 */
import type { PlanPolicies } from "../Plan/index.ts"

export interface DiagnosticRecord {
  readonly code: number | string
  readonly message: string
  readonly category: "error" | "warning" | "message" | "suggestion"
  readonly fileName?: string | undefined
  readonly start?: number | undefined
  readonly length?: number | undefined
}

export interface DiagnosticDiff {
  readonly introduced: ReadonlyArray<DiagnosticRecord>
  readonly resolved: ReadonlyArray<DiagnosticRecord>
  readonly unchanged: ReadonlyArray<DiagnosticRecord>
}

export interface AllowedError {
  readonly code: number | string
  readonly max?: number | undefined
}

export interface PolicyEvaluationContext {
  readonly actualMatches: number
  readonly affectedFiles: number
  readonly diagnosticDiff: DiagnosticDiff
  readonly replayEdits?: number | undefined
  /** Codes `allowErrors()` has permitted through the default no-new-errors gate. */
  readonly allowedErrors?: ReadonlyArray<AllowedError> | undefined
}

export interface VerificationRule {
  readonly name: string
  readonly evaluate: (context: PolicyEvaluationContext) => boolean | string
  /** When set, this rule also exempts the listed code from no-new-errors. */
  readonly allowedError?: AllowedError | undefined
}

export interface Policy {
  readonly matchCount?:
    | { readonly min?: number | undefined; readonly max?: number | undefined }
    | undefined
  readonly maxAffectedFiles?: number | undefined
  readonly diagnostics?: PlanPolicies["diagnostics"] | undefined
  readonly idempotence?: PlanPolicies["idempotence"] | undefined
  readonly rules?: ReadonlyArray<VerificationRule> | undefined
}

export type PlanPolicy = Omit<Policy, "rules">

export interface CompiledPolicy {
  readonly policy: PlanPolicies
  readonly rules: ReadonlyArray<VerificationRule>
}

export const computeDiagnosticDiff = (
  baseline: ReadonlyArray<DiagnosticRecord>,
  proposed: ReadonlyArray<DiagnosticRecord>,
): DiagnosticDiff => {
  // Category and the complete location are part of diagnostic identity.  In
  // particular, a warning becoming an error must be treated as an introduced
  // error even when its code and message stay the same.
  const key = (diagnostic: DiagnosticRecord) =>
    JSON.stringify([
      diagnostic.category,
      diagnostic.code,
      diagnostic.fileName ?? null,
      diagnostic.start ?? null,
      diagnostic.length ?? null,
      diagnostic.message,
    ])
  const group = (diagnostics: ReadonlyArray<DiagnosticRecord>) => {
    const grouped = new Map<string, Array<DiagnosticRecord>>()
    for (const diagnostic of diagnostics) {
      const diagnosticKey = key(diagnostic)
      const matches = grouped.get(diagnosticKey)
      if (matches === undefined) grouped.set(diagnosticKey, [diagnostic])
      else matches.push(diagnostic)
    }
    return grouped
  }
  const baselineMap = group(baseline)
  const proposedMap = group(proposed)

  const introduced: Array<DiagnosticRecord> = []
  const unchanged: Array<DiagnosticRecord> = []
  const resolved: Array<DiagnosticRecord> = []

  for (const [diagnosticKey, diagnostics] of proposedMap.entries()) {
    const baselineMatches = baselineMap.get(diagnosticKey)?.length ?? 0
    unchanged.push(...diagnostics.slice(0, baselineMatches))
    introduced.push(...diagnostics.slice(baselineMatches))
  }

  for (const [diagnosticKey, diagnostics] of baselineMap.entries()) {
    const proposedMatches = proposedMap.get(diagnosticKey)?.length ?? 0
    resolved.push(...diagnostics.slice(proposedMatches))
  }

  return { introduced, resolved, unchanged }
}

const diagnosticCodeKey = (code: number | string): string => String(code).replace(/^TS/, "")

/** Collect `allowErrors()` exemptions recorded on compiled verification rules. */
export const allowedErrorsFromRules = (
  rules: ReadonlyArray<VerificationRule>,
): ReadonlyArray<AllowedError> =>
  rules.flatMap((rule) => (rule.allowedError === undefined ? [] : [rule.allowedError]))

/**
 * New error diagnostics that are not covered by `allowErrors()`. Each listed
 * code may consume up to its `max` (unbounded when omitted).
 */
export const unpermittedIntroducedErrors = (
  diff: DiagnosticDiff,
  allowed: ReadonlyArray<AllowedError> = [],
): ReadonlyArray<DiagnosticRecord> => {
  const remaining = new Map<string, number>()
  for (const entry of allowed) {
    remaining.set(diagnosticCodeKey(entry.code), entry.max ?? Infinity)
  }
  const unpermitted: Array<DiagnosticRecord> = []
  for (const diagnostic of diff.introduced) {
    if (diagnostic.category !== "error") continue
    const key = diagnosticCodeKey(diagnostic.code)
    const left = remaining.get(key)
    if (left === undefined || left <= 0) {
      unpermitted.push(diagnostic)
      continue
    }
    remaining.set(key, left - 1)
  }
  return unpermitted
}

/** Require the primary-run match count to fall within the given bounds. */
export const matches = (bounds: { readonly min?: number; readonly max?: number }): Policy => ({
  matchCount: bounds,
})

/** Require exactly `count` primary-run matches. */
export const exactly = (count: number): Policy => ({ matchCount: { min: count, max: count } })

/** Cap the number of files a plan may touch. */
export const atMostFiles = (count: number): Policy => ({ maxAffectedFiles: count })

/** Reject the plan if verification finds any new error diagnostic. This is the default. */
export const noNewErrors = (): Policy => ({
  diagnostics: "no-new-errors",
  rules: [
    {
      name: "no-new-errors",
      evaluate: (ctx) => {
        const newErrors = unpermittedIntroducedErrors(ctx.diagnosticDiff, ctx.allowedErrors ?? [])
        return newErrors.length === 0
          ? true
          : `Introduced ${newErrors.length} new error diagnostic(s): ${newErrors.map((e) => `TS${e.code}: ${e.message}`).join("; ")}`
      },
    },
  ],
})

/** Require that this transformation actively resolves specific compiler error diagnostic(s). */
export const fixesError = (code: number | string): Policy => ({
  rules: [
    {
      name: `fixes-error:TS${code}`,
      evaluate: (ctx) => {
        const targetStr = String(code).replace(/^TS/, "")
        const resolved = ctx.diagnosticDiff.resolved.some(
          (d) => String(d.code).replace(/^TS/, "") === targetStr,
        )
        return resolved
          ? true
          : `Expected transformation to resolve diagnostic TS${code}, but it was not resolved.`
      },
    },
  ],
})

/** Allow specific error codes up to a given count. */
export const allowErrors = (options: {
  readonly code: number | string
  readonly max?: number
}): Policy => ({
  rules: [
    {
      name: `allow-errors:TS${options.code}`,
      allowedError: { code: options.code, max: options.max },
      evaluate: (ctx) => {
        const targetStr = diagnosticCodeKey(options.code)
        const matchingIntroduced = ctx.diagnosticDiff.introduced.filter(
          (d) => diagnosticCodeKey(d.code) === targetStr,
        )
        const max = options.max ?? Infinity
        return matchingIntroduced.length <= max
          ? true
          : `Allowed at most ${max} occurrences of TS${options.code}, but found ${matchingIntroduced.length}.`
      },
    },
  ],
})

/** Custom policy rule evaluating the complete diagnostic diff. */
export const diagnosticDiff = (
  name: string,
  predicate: (diff: DiagnosticDiff) => boolean | string,
): Policy => ({
  rules: [
    {
      name,
      evaluate: (ctx) => predicate(ctx.diagnosticDiff),
    },
  ],
})

/** Declare that re-running the recipe against the proposed state must produce zero edits. */
export const idempotent = (): Policy => ({ idempotence: "required" })

interface MatchCountBounds {
  min?: number
  max?: number
}

/** Merge policies into the complete durable policy set, filling system defaults. */
export const all = (policies: ReadonlyArray<Policy>): CompiledPolicy => {
  const matchCount: MatchCountBounds = {}
  let maxAffectedFiles: number | undefined
  let diagnostics: PlanPolicies["diagnostics"] = "no-new-errors"
  let idempotence: PlanPolicies["idempotence"] = "not-promised"
  const rules: Array<VerificationRule> = []

  for (const policy of policies) {
    if (policy.matchCount?.min !== undefined) matchCount.min = policy.matchCount.min
    if (policy.matchCount?.max !== undefined) matchCount.max = policy.matchCount.max
    if (policy.maxAffectedFiles !== undefined) maxAffectedFiles = policy.maxAffectedFiles
    if (policy.diagnostics !== undefined) diagnostics = policy.diagnostics
    if (policy.idempotence !== undefined) idempotence = policy.idempotence
    if (policy.rules !== undefined) rules.push(...policy.rules)
  }

  const policy: PlanPolicies = {
    matchCount,
    diagnostics,
    idempotence,
  }
  if (maxAffectedFiles !== undefined) {
    return { policy: { ...policy, maxAffectedFiles }, rules }
  }
  return { policy, rules }
}
