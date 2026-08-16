import { describe, effect, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  computeDiagnosticDiff,
  computeUnifiedDiff,
  Draft,
  Recipe,
  recipeToAgentTool,
  renderDiagnosticDiff,
} from "../api/index.ts"
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

      const diagDiff = computeDiagnosticDiff([], [
        { code: 2322, message: "Type mismatch", category: "error", fileName: "test.ts", start: 0, length: 1 },
      ])
      const renderedDiag = renderDiagnosticDiff(diagDiff, { color: false })
      expect(renderedDiag).toContain("Introduced 1 new diagnostic")
      expect(renderedDiag).toContain("TS2322: Type mismatch")
    })

    effect("bridges recipes into structured agent tools for AI protocols", () =>
      withFixture((_, _app) =>
        Effect.gen(function*() {
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
        })
      ),
      60_000,
    )
  })
})
