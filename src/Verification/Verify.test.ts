import { describe, effect, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Draft from "../Draft/index.ts"
import { computeDiagnosticDiff, type DiagnosticRecord } from "../Policy/index.ts"
import * as Policy from "../Policy/index.ts"
import * as Recipe from "../Recipe/index.ts"
import { VerificationFailure } from "../Verification/index.ts"
import * as Verification from "../Verification/index.ts"
import { WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("declarative transformations API (@effect/vitest)", () => {
  describe("diagnostic diffs and verification policies", () => {
    it("computes diagnostic diffs accurately", () => {
      const baseline: ReadonlyArray<DiagnosticRecord> = [
        { code: 2304, message: "Cannot find name 'foo'", category: "error", fileName: "a.ts", start: 10, length: 3 },
        { code: 6133, message: "'x' is declared but its value is never read", category: "warning", fileName: "a.ts", start: 20, length: 1 },
      ]

      const proposed: ReadonlyArray<DiagnosticRecord> = [
        { code: 6133, message: "'x' is declared but its value is never read", category: "warning", fileName: "a.ts", start: 20, length: 1 },
        { code: 2322, message: "Type 'string' is not assignable to type 'number'", category: "error", fileName: "b.ts", start: 5, length: 6 },
      ]

      const diff = computeDiagnosticDiff(baseline, proposed)
      expect(diff.unchanged).toHaveLength(1)
      expect(diff.unchanged[0]!.code).toBe(6133)
      expect(diff.resolved).toHaveLength(1)
      expect(diff.resolved[0]!.code).toBe(2304)
      expect(diff.introduced).toHaveLength(1)
      expect(diff.introduced[0]!.code).toBe(2322)
    })

    effect("enforces declarative policies during verification", () =>
      withFixture((_, app) =>
        Effect.gen(function*() {
          const validRecipe = Recipe.define("policy-valid", {
            version: "1.0.0",
            policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
                  module: "./library.js",
                  name: "TargetInput",
                })
              }),
          })

          const failingRecipe = Recipe.define("policy-failing", {
            version: "1.0.0",
            policies: [Policy.matches({ min: 999 })],
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
                  module: "./library.js",
                  name: "TargetInput",
                })
              }),
          })

          // Valid passes verification
          const validPlan = yield* Recipe.run(validRecipe, undefined)
          const verified = yield* Verification.verify(validPlan, validRecipe, undefined)
          expect(verified.diagnosticDiff).toBeDefined()

          // Failing policy is rejected during verification
          const failingPlan = yield* Recipe.run(failingRecipe, undefined)
          const failure = yield* Verification.verify(failingPlan, failingRecipe, undefined).pipe(
            Effect.flip,
          )
          expect(failure).toBeInstanceOf(VerificationFailure)
        })
      ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 6. File Lifecycle Operations (Create, Delete, Move + Import Rewriting)
})
