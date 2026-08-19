import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { textHash } from "../Edit/index.ts"
import * as Application from "../Application/index.ts"
import * as Draft from "../Draft/index.ts"
import { applicationLayerNode } from "../Node/index.ts"
import * as Overlay from "../Overlay/index.ts"
import * as Recipe from "../Recipe/index.ts"
import * as Verification from "../Verification/index.ts"
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("declarative transformations API (@effect/vitest)", () => {
  describe("file lifecycle operations in plans", () => {
    effect(
      "creates, deletes, and moves files while rewriting relative imports across referencing files",
      () =>
        withFixture((root, app) =>
          Effect.gen(function* () {
            const mainLayer = applicationLayerNode.pipe(
              Layer.provideMerge(Layer.succeed(Workspace, yield* Workspace)),
            )

            const fileLifecycleRecipe = Recipe.define("file-lifecycle", {
              version: "1.0.0",
              policies: [{ diagnostics: "exact-delta" }],
              run: () =>
                Effect.gen(function* () {
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

            const preview = yield* Verification.of(plan)
            expect(preview.files.length).toBeGreaterThanOrEqual(2)

            const verified = yield* Verification.verify(plan, fileLifecycleRecipe, undefined)
            yield* Application.apply(verified).pipe(Effect.provide(mainLayer))

            // Check created file on disk
            const createdContent = yield* Effect.tryPromise(() =>
              Fs.readFile(Path.join(root, "src/utils.ts"), "utf8"),
            )
            expect(createdContent).toContain("export const magicNumber = 42;")

            // Check moved file on disk
            const movedContent = yield* Effect.tryPromise(() =>
              Fs.readFile(Path.join(root, "src/shared/core.ts"), "utf8"),
            )
            expect(movedContent).toContain("function other(value: number)")

            // Check rewritten relative import in consumer.ts
            const consumerContent = yield* Effect.tryPromise(() =>
              Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
            )
            expect(consumerContent).toContain("./shared/core.js")
          }),
        ),
      60_000,
    )

    effect(
      "rewrites every module-specifier form on move, including the moved file, and fails edits at the pre-move path",
      () =>
        withFixture((root, app) =>
          Effect.gen(function* () {
            const mainLayer = applicationLayerNode.pipe(
              Layer.provideMerge(Layer.succeed(Workspace, yield* Workspace)),
            )
            yield* Effect.tryPromise(() =>
              Fs.writeFile(Path.join(root, "src/peer.ts"), "export const peer = 1;\n"),
            )
            yield* Effect.tryPromise(() =>
              Fs.writeFile(
                Path.join(root, "src/movable.ts"),
                [
                  "// @ts-nocheck",
                  'import { peer } from "./peer.js"',
                  'import * as peerNs from "./peer.js"',
                  'export { peer as movedPeer } from "./peer.js"',
                  'export * from "./peer.js"',
                  'const dynamic = import("./peer.js")',
                  'const required = require("./peer.js")',
                  "export { peer, peerNs, dynamic, required }",
                  "",
                ].join("\n"),
              ),
            )
            yield* Effect.tryPromise(() =>
              Fs.writeFile(
                Path.join(root, "src/specifiers.ts"),
                [
                  "// @ts-nocheck",
                  'import { peer } from "./movable.js"',
                  'import * as movableNs from "./movable.js"',
                  'export { peer as publicPeer } from "./movable.js"',
                  'export * from "./movable.js"',
                  'const dynamic = import("./movable.js")',
                  'const required = require("./movable.js")',
                  "export { movableNs, dynamic, required }",
                  "",
                ].join("\n"),
              ),
            )

            const moveRecipe = Recipe.define("move-specifiers", {
              version: "1.0.0",
              policies: [{ diagnostics: "exact-delta" }],
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.files.move(project, "src/movable.ts", "src/nested/moved.ts")
                }),
            })

            const workspace = yield* Workspace
            const preMoveFail = yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const moveDraft = yield* Draft.files.move(
                  project,
                  "src/movable.ts",
                  "src/nested/moved.ts",
                )
                return yield* Overlay.materialize(
                  snapshot,
                  [
                    {
                      projectId: app.id,
                      fileName: "src/movable.ts",
                      start: 0,
                      end: 0,
                      expectedTextHash: textHash(""),
                      newText: "// pre-move\n",
                      evidenceIds: [],
                    },
                  ],
                  moveDraft.fileOperations,
                ).pipe(Effect.result)
              }),
            )
            expect(preMoveFail._tag).toBe("Failure")

            const plan = yield* Recipe.run(moveRecipe, undefined)
            const move = plan.fileOperations?.find((operation) => operation.kind === "move")
            expect(move?.kind === "move" ? move.content : "").toContain("../peer.js")
            expect(plan.edits.some((edit) => edit.fileName === "src/specifiers.ts")).toBe(true)

            const verified = yield* Verification.verify(plan, moveRecipe, undefined)
            yield* Application.apply(verified).pipe(Effect.provide(mainLayer))

            const moved = yield* Effect.tryPromise(() =>
              Fs.readFile(Path.join(root, "src/nested/moved.ts"), "utf8"),
            )
            const specifiers = yield* Effect.tryPromise(() =>
              Fs.readFile(Path.join(root, "src/specifiers.ts"), "utf8"),
            )
            expect(moved).toContain('from "../peer.js"')
            expect(moved).toContain('import * as peerNs from "../peer.js"')
            expect(moved).toContain('export { peer as movedPeer } from "../peer.js"')
            expect(moved).toContain('export * from "../peer.js"')
            expect(moved).toContain('import("../peer.js")')
            expect(moved).toContain('require("../peer.js")')
            expect(specifiers).toContain('from "./nested/moved.js"')
            expect(specifiers).toContain('import * as movableNs from "./nested/moved.js"')
            expect(specifiers).toContain('export { peer as publicPeer } from "./nested/moved.js"')
            expect(specifiers).toContain('export * from "./nested/moved.js"')
            expect(specifiers).toContain('import("./nested/moved.js")')
            expect(specifiers).toContain('require("./nested/moved.js")')
          }),
        ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 7. Declaration Combinators (Interfaces, Classes, Functions)
})
