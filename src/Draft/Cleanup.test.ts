import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as Application from "../Application/index.ts"
import * as Draft from "../Draft/index.ts"
import { applicationLayerNode, workspaceLayerNode } from "../Node/index.ts"
import * as Recipe from "../Recipe/index.ts"
import * as Verification from "../Verification/index.ts"
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("declarative transformations API (@effect/vitest)", () => {
  describe("automated cleanup and import organizing", () => {
    effect(
      "organizes, deduplicates, and sorts imports deterministically",
      () =>
        withFixture((root, app) =>
          Effect.gen(function* () {
            const consumerPath = Path.join(root, "src/consumer.ts")
            const consumer = yield* Effect.tryPromise(() => Fs.readFile(consumerPath, "utf8"))
            yield* Effect.tryPromise(() =>
              Fs.writeFile(
                consumerPath,
                consumer.replace(
                  'import { other, target as renamed } from "./library.js"',
                  [
                    'import { target as renamed } from "./library.js";',
                    'import { other } from "./library.js";',
                  ].join("\n"),
                ),
              ),
            )
            const workspaceLayer = workspaceLayerNode({ projects: [app] }, { cwd: root })
            const mainLayer = applicationLayerNode.pipe(Layer.provideMerge(workspaceLayer))

            const organizeRecipe = Recipe.define("organize-imports-recipe", {
              version: "1.0.0",
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.imports.organize(project, "src/consumer.ts")
                }),
            })

            const plan = yield* Recipe.run(organizeRecipe, undefined).pipe(
              Effect.provide(workspaceLayer),
            )
            expect(plan.edits.length).toBe(1)

            const verified = yield* Verification.verify(plan, organizeRecipe, undefined).pipe(
              Effect.provide(workspaceLayer),
            )
            yield* Application.apply(verified).pipe(Effect.provide(mainLayer))

            const consumerContent = yield* Effect.tryPromise(() =>
              Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
            )
            expect(consumerContent).toContain(
              'import { other, target as renamed } from "./library.js";',
            )

            const rerunWorkspaceLayer = workspaceLayerNode({ projects: [app] }, { cwd: root })
            const secondPlan = yield* Recipe.run(organizeRecipe, undefined).pipe(
              Effect.provide(rerunWorkspaceLayer),
            )
            expect(secondPlan.edits).toEqual([])
          }),
        ),
      60_000,
    )

    effect(
      "cleans up unused imports automatically with Draft.cleanUnused",
      () =>
        withFixture((root, app) =>
          Effect.gen(function* () {
            const mainLayer = applicationLayerNode.pipe(
              Layer.provideMerge(Layer.succeed(Workspace, yield* Workspace)),
            )

            // First add an unused import
            const addUnusedRecipe = Recipe.define("add-unused-import", {
              version: "1.0.0",
              policies: [{ diagnostics: "exact-delta" }],
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
                    module: "effect",
                    name: "DanglingUnusedSymbol",
                  })
                }),
            })

            const plan1 = yield* Recipe.run(addUnusedRecipe, undefined)
            const verified1 = yield* Verification.verify(plan1, addUnusedRecipe, undefined)
            yield* Application.apply(verified1).pipe(Effect.provide(mainLayer))

            // Now run cleanUnused recipe
            const cleanRecipe = Recipe.define("clean-unused-recipe", {
              version: "1.0.0",
              policies: [{ diagnostics: "exact-delta" }],
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.cleanUnused(project)
                }),
            })

            const cleanWorkspaceLayer = workspaceLayerNode({ projects: [app] }, { cwd: root })
            const cleanMainLayer = applicationLayerNode.pipe(
              Layer.provideMerge(cleanWorkspaceLayer),
            )
            const plan2 = yield* Recipe.run(cleanRecipe, undefined).pipe(
              Effect.provide(cleanWorkspaceLayer),
            )
            expect(plan2.edits.length).toBeGreaterThanOrEqual(1)

            const verified2 = yield* Verification.verify(plan2, cleanRecipe, undefined).pipe(
              Effect.provide(cleanWorkspaceLayer),
            )
            yield* Application.apply(verified2).pipe(Effect.provide(cleanMainLayer))

            const consumerContent = yield* Effect.tryPromise(() =>
              Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
            )
            expect(consumerContent).not.toContain("DanglingUnusedSymbol")
          }),
        ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 9. Interactive CLI, Terminal Diff Rendering & Agent Tool Protocol
})
