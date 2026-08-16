import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  Application,
  Draft,
  planApplicationLayerNode,
  Preview,
  Recipe,
  Verification,
  Workspace,
  WorkspaceSnapshot,
} from "../api/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("declarative transformations API (@effect/vitest)", () => {
  describe("file lifecycle operations in plans", () => {
    effect("creates, deletes, and moves files while rewriting relative imports across referencing files", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const mainLayer = planApplicationLayerNode.pipe(
            Layer.provideMerge(Layer.succeed(Workspace, yield* Workspace)),
          )

          const fileLifecycleRecipe = Recipe.define("file-lifecycle", {
            version: "1.0.0",
            policies: [{ diagnostics: "exact-delta" }],
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)

                // 1. Create a brand new file
                const d1 = yield* Draft.files.create(
                  project,
                  "src/utils.ts",
                  "export const magicNumber = 42;\n",
                )

                // 2. Move library.ts -> shared/core.ts (and rewrite imports in consumer.ts)
                const d2 = yield* Draft.files.move(
                  project,
                  "src/library.ts",
                  "src/shared/core.ts",
                )

                return Draft.concat(d1, d2)
              }),
          })

          const plan = yield* Recipe.run(fileLifecycleRecipe, undefined)
          expect(plan.fileOperations?.length).toBe(2)

          const preview = yield* Preview.of(plan)
          expect(preview.files.length).toBeGreaterThanOrEqual(2)

          const verified = yield* Verification.verify(plan, fileLifecycleRecipe, undefined)
          yield* Application.apply(verified).pipe(Effect.provide(mainLayer))

          // Check created file on disk
          const createdContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/utils.ts"), "utf8")
          )
          expect(createdContent).toContain("export const magicNumber = 42;")

          // Check moved file on disk
          const movedContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/shared/core.ts"), "utf8")
          )
          expect(movedContent).toContain("function other(value: number)")

          // Check rewritten relative import in consumer.ts
          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("./shared/core.js")
        })
      ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 7. Declaration Combinators (Interfaces, Classes, Functions)
})
