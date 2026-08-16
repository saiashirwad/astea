import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import {
  overlay,
  Draft,
  Workspace,
  WorkspaceSnapshot,
} from "../api/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("declarative transformations API (@effect/vitest)", () => {
  describe("in-memory snapshot transitions", () => {
    effect("chains semantic queries across in-memory overlays without touching disk", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot({}, Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)

            // Stage 1: Propose an edit to library.ts in memory
            const libFile = yield* project.sourceFile("src/library.ts")
            expect(libFile).toBeDefined()

            const draft1 = yield* Draft.imports.addNamed(project, "src/library.ts", {
              module: "effect",
              name: "Option",
            })
            expect(draft1.edits).toHaveLength(1)

            // Stage 2: Evaluate inside in-memory overlay
            yield* overlay(draft1, Effect.gen(function*() {
              const overlaySnapshot = yield* WorkspaceSnapshot
              const overlayProject = yield* overlaySnapshot.project(app)

              const updatedLib = yield* overlayProject.sourceFile("src/library.ts")
              expect(updatedLib?.text).toContain('import { Option } from "effect"')

              // Verify that disk was untouched
              const diskContent = yield* Effect.tryPromise(() =>
                Fs.readFile(Path.join(root, "src/library.ts"), "utf8")
              )
              expect(diskContent).not.toContain('import { Option } from "effect"')
            }))
          }))
        })
      ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 2. Declarative Semantic Query Algebra & Pattern Matchers
})
