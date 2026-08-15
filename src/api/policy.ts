/**
 * Candidate public API — Plan Policies.
 *
 * Policies are plain values: explicit, inspectable conditions a particular
 * Transformation Plan must satisfy to verify or apply. They compose by
 * merging; unset dimensions fall back to the system defaults (no new error
 * diagnostics, unbounded cardinality, idempotence not promised).
 */
import type { PlanPolicies } from "../prototype/plan.ts"

export interface Policy {
  readonly matchCount?: { readonly min?: number; readonly max?: number }
  readonly maxAffectedFiles?: number
  readonly diagnostics?: PlanPolicies["diagnostics"]
  readonly idempotence?: PlanPolicies["idempotence"]
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
export const noNewErrors = (): Policy => ({ diagnostics: "no-new-errors" })

/** Declare that re-running the recipe against the proposed state must produce zero edits. */
export const idempotent = (): Policy => ({ idempotence: "required" })

/** Merge policies into the complete durable policy set, filling system defaults. */
export const all = (policies: ReadonlyArray<Policy>): PlanPolicies => {
  const matchCount: { min?: number; max?: number } = {}
  let maxAffectedFiles: number | undefined
  let diagnostics: PlanPolicies["diagnostics"] = "no-new-errors"
  let idempotence: PlanPolicies["idempotence"] = "not-promised"
  for (const policy of policies) {
    if (policy.matchCount?.min !== undefined) matchCount.min = policy.matchCount.min
    if (policy.matchCount?.max !== undefined) matchCount.max = policy.matchCount.max
    if (policy.maxAffectedFiles !== undefined) maxAffectedFiles = policy.maxAffectedFiles
    if (policy.diagnostics !== undefined) diagnostics = policy.diagnostics
    if (policy.idempotence !== undefined) idempotence = policy.idempotence
  }
  return {
    matchCount,
    ...(maxAffectedFiles === undefined ? {} : { maxAffectedFiles }),
    diagnostics,
    idempotence,
  }
}

export const Policy = {
  matches,
  exactly,
  atMostFiles,
  noNewErrors,
  idempotent,
  all,
}
