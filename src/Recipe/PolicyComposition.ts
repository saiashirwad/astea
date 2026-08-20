/** Policy composition for recipes that contain child recipes. */
import type { PlanPolicies } from "../Plan/index.ts"
import type { Recipe } from "./Model.ts"

const tighterMin = (current: number | undefined, next: number | undefined): number | undefined =>
  current === undefined ? next : next === undefined ? current : Math.max(current, next)

const tighterMax = (current: number | undefined, next: number | undefined): number | undefined =>
  current === undefined ? next : next === undefined ? current : Math.min(current, next)

interface MatchCountBounds {
  min?: number
  max?: number
}

/** Intersect durable child policies and preserve all runtime rules. */
export const compileChildren = (recipes: ReadonlyArray<Recipe<any, any, any>>) => ({
  policy: (() => {
    let min: number | undefined
    let max: number | undefined
    let maxAffectedFiles: number | undefined
    let idempotence: PlanPolicies["idempotence"] = "not-promised"
    for (const recipe of recipes) {
      const policy = recipe.policies
      min = tighterMin(min, policy.matchCount.min)
      max = tighterMax(max, policy.matchCount.max)
      maxAffectedFiles = tighterMax(maxAffectedFiles, policy.maxAffectedFiles)
      if (policy.idempotence === "required") idempotence = "required"
    }
    const diagnostics: PlanPolicies["diagnostics"] =
      recipes.length === 0 ||
      recipes.some((recipe) => recipe.policies.diagnostics === "no-new-errors")
        ? "no-new-errors"
        : "exact-delta"
    const matchCount: MatchCountBounds = {}
    if (min !== undefined) matchCount.min = min
    if (max !== undefined) matchCount.max = max
    return maxAffectedFiles === undefined
      ? { matchCount, diagnostics, idempotence }
      : { matchCount, maxAffectedFiles, diagnostics, idempotence }
  })(),
  rules: recipes.flatMap((recipe) => recipe.rules),
})
