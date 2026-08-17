import { describe, effect, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { recipeToAgentTool, ToolExecutionError } from "../AgentTool/index.ts"
import { computeUnifiedDiff, renderDiagnosticDiff } from "../Cli/index.ts"
import * as Draft from "../Draft/index.ts"
import * as Policy from "../Policy/index.ts"
import { computeDiagnosticDiff } from "../Policy/index.ts"
import * as Recipe from "../Recipe/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("declarative transformations API (@effect/vitest)", () => {
  describe("diff rendering and agent tool protocol", () => {
    it("renders colored unified diffs and diagnostic reports", () => {
      const before = "const a = 1;\nconst b = 2;\n"
      const after = "const a = 1;\nconst b = 42;\nconst c = 3;\n"

      const diff = computeUnifiedDiff("test.ts", before, after, { color: false })
      expect(diff).toContain("- const b = 2;")
      expect(diff).toContain("+ const b = 42;")
      expect(diff).toContain("+ const c = 3;")

      const diagDiff = computeDiagnosticDiff(
        [],
        [
          {
            code: 2322,
            message: "Type mismatch",
            category: "error",
            fileName: "test.ts",
            start: 0,
            length: 1,
          },
        ],
      )
      const renderedDiag = renderDiagnosticDiff(diagDiff, { color: false })
      expect(renderedDiag).toContain("Introduced 1 new diagnostic")
      expect(renderedDiag).toContain("TS2322: Type mismatch")
    })

    effect(
      "bridges recipes into structured agent tools for AI protocols",
      () =>
        withFixture((_, _app) =>
          Effect.gen(function* () {
            const sampleRecipe = Recipe.define("agent-tool-sample", {
              version: "1.0.0",
              schema: Schema.Struct({ multiplier: Schema.Finite }),
              run: () => Effect.succeed(Draft.empty),
            })

            const tool = recipeToAgentTool(sampleRecipe, "Sample codemod tool")
            expect(tool.name).toBe("safemods_agent_tool_sample")
            expect(tool.description).toBe("Sample codemod tool")
            expect(tool.schema).toBeDefined()

            const result = yield* tool.execute({ multiplier: 10 })
            expect(result.status).toBe("preview")
            expect(result.planId).toBeDefined()
            expect(result.diagnostics.introduced).toEqual([])
            expect(result.policyResults.length).toBeGreaterThan(0)
          }),
        ),
      60_000,
    )

    effect(
      "returns structured schema and verification failures",
      () =>
        withFixture((_, _app) =>
          Effect.gen(function* () {
            const schemaRecipe = Recipe.define("agent-tool-schema-error", {
              version: "1.0.0",
              schema: Schema.Struct({ multiplier: Schema.Finite }),
              run: () => Effect.succeed(Draft.empty),
            })
            const schemaResult = yield* Effect.match(
              recipeToAgentTool(schemaRecipe).execute({ multiplier: "not-a-number" }),
              {
                onFailure: (error) => ({ _tag: "failure" as const, error }),
                onSuccess: (value) => ({ _tag: "success" as const, value }),
              },
            )
            expect(schemaResult._tag).toBe("failure")
            if (schemaResult._tag === "failure") {
              expect(schemaResult.error).toBeInstanceOf(ToolExecutionError)
              expect(schemaResult.error.details).toEqual({
                _tag: "SchemaError",
                issues: [
                  {
                    path: ["multiplier"],
                    code: "InvalidType",
                    message: "Expected number",
                  },
                ],
              })
            }

            const verificationRecipe = Recipe.define("agent-tool-verification-error", {
              version: "1.0.0",
              policies: [Policy.exactly(1)],
              run: () => Effect.succeed(Draft.empty),
            })
            const verificationResult = yield* Effect.match(
              recipeToAgentTool(verificationRecipe).execute(null),
              {
                onFailure: (error) => ({ _tag: "failure" as const, error }),
                onSuccess: (value) => ({ _tag: "success" as const, value }),
              },
            )
            expect(verificationResult._tag).toBe("failure")
            if (verificationResult._tag === "failure") {
              expect(verificationResult.error.details).toEqual({
                _tag: "VerificationFailure",
                policy: "matches",
                detail: "Observed 0",
                diagnostics: [],
              })
            }
          }),
        ),
      60_000,
    )
  })
})
