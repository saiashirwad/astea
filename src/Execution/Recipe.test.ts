import { nodeFsPromises as Fs, path as Path } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import * as Draft from "../Draft/index.ts"
import { applicationLayerNode } from "../Node/index.ts"
import * as Recipe from "../Recipe/index.ts"
import { WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"
import { executeRecipe } from "./Recipe.ts"

describe("recipe execution workflow", () => {
  effect("runs only the stages selected by the mode", () =>
    withFixture(() =>
      Effect.gen(function* () {
        const recipe = Recipe.define("execution-stages", {
          version: "1.0.0",
          run: () => Effect.succeed(Draft.empty),
        })
        const stages: Array<string> = []
        const hooks = {
          onPreview: () => Effect.sync(() => stages.push("preview")),
          onVerified: () => Effect.sync(() => stages.push("verify")),
        }

        const planned = yield* executeRecipe(recipe, undefined, { mode: "plan", hooks })
        expect(planned.mode).toBe("plan")
        expect(stages).toEqual([])

        const previewed = yield* executeRecipe(recipe, undefined, { mode: "preview", hooks })
        expect(previewed.mode).toBe("preview")
        expect(stages).toEqual(["preview"])

        stages.length = 0
        const verified = yield* executeRecipe(recipe, undefined, { mode: "verify", hooks })
        expect(verified.mode).toBe("verify")
        expect(stages).toEqual(["preview", "verify"])
      }),
    ),
  )

  effect("applies only after preview and verification hooks", () =>
    withFixture((root, app) =>
      Effect.gen(function* () {
        const stages: Array<string> = []
        const recipe = Recipe.define("execution-apply", {
          version: "1.0.0",
          run: () =>
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              return yield* Draft.files.create(
                project,
                "src/executed.ts",
                "export const executed = true;\n",
              )
            }),
        })

        const execution = yield* executeRecipe(recipe, undefined, {
          mode: "apply",
          hooks: {
            onPreview: () => Effect.sync(() => stages.push("preview")),
            onVerified: () => Effect.sync(() => stages.push("verify")),
          },
        }).pipe(Effect.provide(applicationLayerNode))

        expect(execution.mode).toBe("apply")
        expect(stages).toEqual(["preview", "verify"])
        expect(execution.receipt.outputs).toHaveLength(1)
        expect(
          yield* Effect.promise(() => Fs.readFile(Path.join(root, "src/executed.ts"), "utf8")),
        ).toBe("export const executed = true;\n")
      }),
    ),
  )
})
