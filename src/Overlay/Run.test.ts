import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import { textHash } from "../Edit/index.ts"
import * as Draft from "../Draft/index.ts"
import * as Overlay from "../Overlay/index.ts"
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("declarative transformations API (@effect/vitest)", () => {
  describe("in-memory snapshot transitions", () => {
    effect(
      "chains semantic queries across in-memory overlays without touching disk",
      () =>
        withFixture((root, app) =>
          Effect.gen(function* () {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)

                const libFile = yield* project.sourceFile("src/library.ts")
                expect(libFile).toBeDefined()

                const draft1 = yield* Draft.imports.addNamed(project, "src/library.ts", {
                  module: "effect",
                  name: "Option",
                })
                expect(draft1.edits).toHaveLength(1)

                yield* Overlay.run(
                  draft1,
                  Effect.gen(function* () {
                    const overlaySnapshot = yield* WorkspaceSnapshot
                    const overlayProject = yield* overlaySnapshot.project(app)

                    const updatedLib = yield* overlayProject.sourceFile("src/library.ts")
                    expect(updatedLib?.text).toContain('import { Option } from "effect"')

                    const diskContent = yield* Effect.tryPromise(() =>
                      Fs.readFile(Path.join(root, "src/library.ts"), "utf8"),
                    )
                    expect(diskContent).not.toContain('import { Option } from "effect"')
                  }),
                )
              }),
            )
          }),
        ),
      60_000,
    )

    effect(
      "keeps file lifecycle state coherent across piped stages",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)

                const createdText = "export const value = 1;\n"
                const createDraft = yield* Draft.files.create(
                  project,
                  "src/generated.ts",
                  createdText,
                )
                const createdOverlay = yield* Overlay.materialize(
                  snapshot,
                  [
                    {
                      projectId: app.id,
                      fileName: "src/generated.ts",
                      start: createdText.indexOf("1"),
                      end: createdText.indexOf("1") + 1,
                      expectedTextHash: textHash("1"),
                      newText: "2",
                      evidenceIds: [],
                    },
                  ],
                  createDraft.fileOperations,
                )
                expect(createdOverlay[Path.resolve(project.root, "src/generated.ts")]).toContain(
                  "value = 2",
                )

                const source = yield* project.sourceText("src/library.ts")
                const moveDraft = yield* Draft.files.move(
                  project,
                  "src/library.ts",
                  "src/shared/core.ts",
                )
                const movedOverlay = yield* Overlay.materialize(
                  snapshot,
                  [
                    {
                      projectId: app.id,
                      fileName: "src/shared/core.ts",
                      start: 0,
                      end: 0,
                      expectedTextHash: textHash(""),
                      newText: "// moved edit\n",
                      evidenceIds: [],
                    },
                  ],
                  moveDraft.fileOperations,
                )
                expect(movedOverlay[Path.resolve(project.root, "src/shared/core.ts")]).toContain(
                  "moved edit",
                )

                const deleteDraft = yield* Draft.files.delete(project, "src/library.ts")
                const deletedOverlay = yield* Overlay.materialize(
                  snapshot,
                  [
                    {
                      projectId: app.id,
                      fileName: "src/library.ts",
                      start: 0,
                      end: source.length,
                      expectedTextHash: textHash(source),
                      newText: "resurrected",
                      evidenceIds: [],
                    },
                  ],
                  deleteDraft.fileOperations,
                ).pipe(Effect.result)
                expect(deletedOverlay._tag).toBe("Failure")
              }),
            )
          }),
        ),
      60_000,
    )
  })
})
