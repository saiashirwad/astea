import { describe, expect, it } from "vitest"
import type { DiagnosticDiff, PolicyEvaluationContext } from "../Policy/index.ts"
import { evaluateBuiltInPolicies, evaluateCustomRules } from "./PolicyEvaluation.ts"

const emptyDiagnosticDiff: DiagnosticDiff = {
  introduced: [],
  resolved: [],
  unchanged: [],
}

describe("policy evaluation", () => {
  it("reports built-in policies in their stable order", () => {
    const evaluation = evaluateBuiltInPolicies({
      policies: {
        matchCount: { min: 1, max: 2 },
        maxAffectedFiles: 2,
        diagnostics: "no-new-errors",
        idempotence: "required",
      },
      actualMatches: 1,
      affectedFiles: 1,
      baselineErrorCount: 0,
      proposedErrorCount: 0,
      diagnosticDiff: emptyDiagnosticDiff,
      secondPlanChangeCount: 0,
    })

    expect(evaluation.failure).toBeUndefined()
    expect(evaluation.results).toEqual([
      { name: "match-count", passed: true },
      { name: "affected-files", passed: true },
      { name: "no-new-errors", passed: true },
      { name: "idempotence", passed: true },
    ])
  })

  it("keeps the established built-in failure order", () => {
    const diagnosticDiff: DiagnosticDiff = {
      ...emptyDiagnosticDiff,
      introduced: [{ code: 1, message: "new error", category: "error" }],
    }
    const evaluation = evaluateBuiltInPolicies({
      policies: {
        matchCount: { min: 2 },
        maxAffectedFiles: 0,
        diagnostics: "no-new-errors",
        idempotence: "required",
      },
      actualMatches: 1,
      affectedFiles: 1,
      baselineErrorCount: 0,
      proposedErrorCount: 1,
      diagnosticDiff,
      secondPlanChangeCount: 1,
    })

    expect(evaluation.failure).toEqual({ policy: "matches", detail: "Observed 1" })
  })

  it("stops custom rules at the first failure", () => {
    const visited: Array<string> = []
    const context: PolicyEvaluationContext = {
      actualMatches: 0,
      affectedFiles: 0,
      diagnosticDiff: emptyDiagnosticDiff,
    }
    const evaluation = evaluateCustomRules(
      [
        {
          name: "first",
          evaluate: () => {
            visited.push("first")
            return true
          },
        },
        {
          name: "second",
          evaluate: () => {
            visited.push("second")
            return "failed"
          },
        },
        {
          name: "third",
          evaluate: () => {
            visited.push("third")
            return true
          },
        },
      ],
      context,
    )

    expect(visited).toEqual(["first", "second"])
    expect(evaluation.results).toEqual([
      { name: "first", passed: true },
      { name: "second", passed: false, detail: "failed" },
    ])
    expect(evaluation.failure?.policy).toBe("diagnostics")
  })
})
