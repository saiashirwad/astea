import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import { textHash } from "../Edit/index.ts"
import * as Draft from "../Draft/index.ts"
import * as Overlay from "../Overlay/index.ts"
import * as Recipe from "../Recipe/index.ts"
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

                // Stage 1: Propose an edit to library.ts in memory
                const libFile = yield* project.sourceFile("src/library.ts")
                expect(libFile).toBeDefined()

                const draft1 = yield* Draft.imports.addNamed(project, "src/library.ts", {
                  module: "effect",
                  name: "Option",
                })
                expect(draft1.edits).toHaveLength(1)

                // Stage 2: Evaluate inside in-memory overlay
                yield* Overlay.run(
                  draft1,
                  Effect.gen(function* () {
                    const overlaySnapshot = yield* WorkspaceSnapshot
                    const overlayProject = yield* overlaySnapshot.project(app)

                    const updatedLib = yield* overlayProject.sourceFile("src/library.ts")
                    expect(updatedLib?.text).toContain('import { Option } from "effect"')

                    // Verify that disk was untouched
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
                )
                expect(deletedOverlay[Path.resolve(project.root, "src/library.ts")]).toBeUndefined()

                const textEdit = Recipe.define("text-edit", {
                  version: "1.0.0",
                  run: () =>
                    Effect.gen(function* () {
                      const file = yield* project.file("src/consumer.ts")
                      const source = yield* file.sourceFile
                      return yield* Draft.replace(
                        project,
                        source,
                        `${source.text}\n// text stage\n`,
                      )
                    }),
                })
                const operationOnly = Recipe.define("operation-only", {
                  version: "1.0.0",
                  run: () =>
                    Draft.files.create(
                      project,
                      "src/operation-only.ts",
                      "export const operationOnly = true;\n",
                    ),
                })
                const staged = yield* Recipe.pipe(textEdit, operationOnly).run(undefined)
                expect(staged.edits.length).toBeGreaterThan(0)
                expect(staged.fileOperations?.length).toBe(1)
                expect(staged.evidence.length).toBeGreaterThan(0)
                expect(staged.matches).toBeGreaterThanOrEqual(1)
              }),
            )
          }),
        ),
      60_000,
    )

    effect(
      "lets later piped recipes query created or moved files and makes delete terminal",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const create = Recipe.define("pipe-create", {
              version: "1.0.0",
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.files.create(
                    project,
                    "src/generated.ts",
                    "export const generated = 1;\n",
                  )
                }),
            })
            const editCreated = Recipe.define("pipe-edit-created", {
              version: "1.0.0",
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  const generated = yield* project.file("src/generated.ts")
                  const source = yield* generated.sourceFile
                  return yield* Draft.replace(project, source, source.text.replace("= 1", "= 2"))
                }),
            })
            const createdPlan = yield* Recipe.run(Recipe.pipe(create, editCreated), undefined)
            const createOperation = createdPlan.fileOperations?.find(
              (operation) => operation.kind === "create",
            )
            expect(createOperation?.kind === "create" ? createOperation.content : "").toContain(
              "generated = 2",
            )
            expect(createdPlan.edits).toHaveLength(0)

            const moveCreated = Recipe.define("pipe-move-created", {
              version: "1.0.0",
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.files.move(
                    project,
                    "src/generated.ts",
                    "src/moved-generated.ts",
                  )
                }),
            })
            const createThenMove = yield* Recipe.run(Recipe.pipe(create, moveCreated), undefined)
            expect(createThenMove.fileOperations).toHaveLength(1)
            expect(createThenMove.fileOperations?.[0]).toMatchObject({
              kind: "create",
              path: "src/moved-generated.ts",
              content: "export const generated = 1;\n",
            })

            const deleteCreated = Recipe.define("pipe-delete-created", {
              version: "1.0.0",
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.files.delete(project, "src/generated.ts")
                }),
            })
            const createThenDelete = yield* Recipe.run(
              Recipe.pipe(create, deleteCreated),
              undefined,
            )
            expect(createThenDelete.fileOperations ?? []).toHaveLength(0)
            expect(createThenDelete.edits).toHaveLength(0)

            const move = Recipe.define("pipe-move", {
              version: "1.0.0",
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.files.move(project, "src/library.ts", "src/moved-library.ts")
                }),
            })
            const editMoved = Recipe.define("pipe-edit-moved", {
              version: "1.0.0",
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  const moved = yield* project.file("src/moved-library.ts")
                  const source = yield* moved.sourceFile
                  return yield* Draft.replace(
                    project,
                    source,
                    `// edited after move\n${source.text}`,
                  )
                }),
            })
            const movedPlan = yield* Recipe.run(Recipe.pipe(move, editMoved), undefined)
            const moveOperation = movedPlan.fileOperations?.find(
              (operation) => operation.kind === "move",
            )
            expect(moveOperation?.kind === "move" ? moveOperation.content : "").toContain(
              "edited after move",
            )
            expect(movedPlan.edits.some((edit) => edit.fileName === "src/moved-library.ts")).toBe(
              false,
            )

            const edit = Recipe.define("pipe-edit-before-delete", {
              version: "1.0.0",
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  const library = yield* project.file("src/library.ts")
                  const source = yield* library.sourceFile
                  return yield* Draft.replace(
                    project,
                    source,
                    `${source.text}\n// transient edit\n`,
                  )
                }),
            })
            const remove = Recipe.define("pipe-delete", {
              version: "1.0.0",
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.files.delete(project, "src/library.ts")
                }),
            })
            const deletedPlan = yield* Recipe.run(Recipe.pipe(edit, remove), undefined)
            expect(
              deletedPlan.fileOperations?.some((operation) => operation.kind === "delete"),
            ).toBe(true)
            expect(
              deletedPlan.edits.some((candidate) => candidate.fileName === "src/library.ts"),
            ).toBe(false)
          }),
        ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 2. Declarative Semantic Query Algebra & Pattern Matchers
})
