import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import * as Application from "../Application/index.ts"
import * as Draft from "../Draft/index.ts"
import { applicationLayerNode } from "../Node/index.ts"
import * as Policy from "../Policy/index.ts"
import * as Query from "../Query/index.ts"
import * as Recipe from "../Recipe/index.ts"
import * as Verification from "../Verification/index.ts"
import { WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("declarative transformations API (@effect/vitest)", () => {
  describe("syntactic draft combinators and rename", () => {
    effect(
      "manipulates imports, call arguments, and object fields preserving formatting",
      () =>
        withFixture((root, app) =>
          Effect.gen(function* () {
            const draftTestRecipe = Recipe.define("draft-test-recipe", {
              version: "1.0.0",
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  const draft = Draft.forProject(project)

                  // 1. Add import
                  const d1 = yield* draft.imports.addNamed("src/consumer.ts", {
                    module: "./library.js",
                    name: "TargetInput",
                  })

                  // 2. Wrap call argument
                  const calls = yield* Query.calls(project).pipe(Query.collect)
                  const targetCall = calls[0]!.value
                  const d2 = yield* draft.args.wrap(
                    targetCall,
                    0,
                    (text) => `/* wrapped */ { value: ${text} }`,
                  )

                  return Draft.concat(d1, d2)
                }),
            })

            const plan = yield* Recipe.run(draftTestRecipe, undefined)
            const verified = yield* Verification.verify(plan, draftTestRecipe, undefined)
            yield* Application.apply(verified).pipe(Effect.provide(applicationLayerNode))

            const consumerContent = yield* Effect.tryPromise(() =>
              Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
            )
            expect(consumerContent).toContain("TargetInput")
            expect(consumerContent).toContain("/* keep this comment */ /* wrapped */ { value: 1 }")
          }),
        ),
      60_000,
    )

    effect(
      "renames symbols across all declarations, imports, and usages with Draft.renameSymbol",
      () =>
        withFixture((root, app) =>
          Effect.gen(function* () {
            const renameRecipe = Recipe.define("rename-other-symbol", {
              version: "1.0.0",
              policies: [Policy.noNewErrors()],
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  const otherSymbol = yield* project.symbolNamed("other", {
                    within: "src/library.ts",
                  })

                  return yield* Draft.forProject(project).renameSymbol(
                    otherSymbol,
                    "transformedOther",
                  )
                }),
            })

            const plan = yield* Recipe.run(renameRecipe, undefined)
            expect(plan.edits.length).toBeGreaterThanOrEqual(2)

            const verified = yield* Verification.verify(plan, renameRecipe, undefined)
            yield* Application.apply(verified).pipe(Effect.provide(applicationLayerNode))

            const libContent = yield* Effect.tryPromise(() =>
              Fs.readFile(Path.join(root, "src/library.ts"), "utf8"),
            )
            const consumerContent = yield* Effect.tryPromise(() =>
              Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
            )

            expect(libContent).toContain("function transformedOther(value: number)")
            expect(consumerContent).toContain("import { transformedOther, target as renamed }")
            expect(consumerContent).toContain("transformedOther(2)")
          }),
        ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 5. Diagnostic Diffs and Declarative Policy Expressions
})
