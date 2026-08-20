import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import * as Draft from "../Draft/index.ts"
import type { Draft as DraftModel } from "../Draft/index.ts"
import { applyFileEdits, textHash, type TextEdit } from "../Edit/index.ts"
import { DraftEvidenceConflict } from "../Evidence/index.ts"
import { requireProjectRelativePath } from "../ProjectPath/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"
import {
  ProjectNotInSnapshot,
  Workspace,
  WorkspaceSnapshot,
  type ConfiguredProject,
  type WorkspaceSnapshotService,
} from "../Workspace/index.ts"
import * as Overlay from "./index.ts"

const evidence = (id: string) => ({ id, kind: "test", facts: { id } })

const withSnapshot = <A, E, R>(
  use: (snapshot: WorkspaceSnapshotService, app: ConfiguredProject) => Effect.Effect<A, E, R>,
) =>
  withFixture((_, app) =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      return yield* workspace.withSnapshot(
        {},
        Effect.gen(function* () {
          const snapshot = yield* WorkspaceSnapshot
          return yield* use(snapshot, app)
        }),
      )
    }),
  )

describe("Overlay.composeDraft", () => {
  effect("collapses distant sequential edits against the original text", () =>
    withSnapshot((snapshot, app) =>
      Effect.gen(function* () {
        const project = yield* snapshot.project(app)
        const original = yield* project.sourceText("src/consumer.ts")
        const firstStart = original.indexOf("renamed")
        const first: TextEdit = {
          projectId: app.id,
          fileName: "src/consumer.ts",
          start: firstStart,
          end: firstStart + "renamed".length,
          expectedTextHash: textHash("renamed"),
          newText: "changedAlias",
          evidenceIds: ["first"],
        }
        const intermediate = yield* applyFileEdits(original, [first])
        const secondStart = intermediate.indexOf("other(2)")
        const second: TextEdit = {
          projectId: app.id,
          fileName: "src/consumer.ts",
          start: secondStart,
          end: secondStart + "other(2)".length,
          expectedTextHash: textHash("other(2)"),
          newText: "other(20)",
          evidenceIds: ["second"],
        }
        const expected = yield* applyFileEdits(intermediate, [second])
        const accumulated: DraftModel = {
          edits: [first],
          fileOperations: [],
          evidence: [evidence("first")],
          matches: 1,
        }
        const next: DraftModel = {
          edits: [second],
          fileOperations: [],
          evidence: [evidence("second")],
          matches: 1,
        }

        const composed = yield* Overlay.composeDraft(accumulated, Effect.succeed(next))
        expect(yield* applyFileEdits(original, composed.edits)).toBe(expected)
        expect(composed.matches).toBe(2)
        expect(composed.evidence.map((item) => item.id)).toEqual(["first", "second"])
      }),
    ),
  )

  effect("puts a later edit into moved file content", () =>
    withSnapshot((snapshot, app) =>
      Effect.gen(function* () {
        const project = yield* snapshot.project(app)
        const original = yield* project.sourceText("src/consumer.ts")
        const editStart = original.indexOf("other(2)")
        const edit: TextEdit = {
          projectId: app.id,
          fileName: "src/moved.ts",
          start: editStart,
          end: editStart + "other(2)".length,
          expectedTextHash: textHash("other(2)"),
          newText: "other(20)",
          evidenceIds: ["edit"],
        }
        const expected = yield* applyFileEdits(original, [edit])
        const accumulated: DraftModel = {
          edits: [],
          fileOperations: [
            {
              kind: "move",
              projectId: app.id,
              path: requireProjectRelativePath("src/consumer.ts"),
              toPath: requireProjectRelativePath("src/moved.ts"),
              initialHash: textHash(original),
              content: original,
              evidenceIds: ["move"],
            },
          ],
          evidence: [evidence("move")],
          matches: 1,
        }
        const next: DraftModel = {
          edits: [edit],
          fileOperations: [],
          evidence: [evidence("edit")],
          matches: 1,
        }

        const composed = yield* Overlay.composeDraft(accumulated, Effect.succeed(next))
        expect(composed.edits).toHaveLength(0)
        expect(composed.fileOperations).toHaveLength(1)
        expect(composed.fileOperations?.[0]).toMatchObject({
          kind: "move",
          path: "src/consumer.ts",
          toPath: "src/moved.ts",
          content: expected,
        })
      }),
    ),
  )

  effect("rejects sequential edits for an unknown project", () =>
    withSnapshot((snapshot) =>
      Effect.gen(function* () {
        const invalidProjectId = "missing-project"
        const first: TextEdit = {
          projectId: invalidProjectId,
          fileName: "src/consumer.ts",
          start: 0,
          end: 0,
          expectedTextHash: textHash(""),
          newText: "first",
          evidenceIds: [],
        }
        const second: TextEdit = {
          ...first,
          newText: "second",
        }
        const result = yield* Effect.result(
          Overlay.composeDraft(
            { edits: [first], fileOperations: [], evidence: [], matches: 1 },
            Effect.succeed({ edits: [second], fileOperations: [], evidence: [], matches: 1 }),
          ),
        )

        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(ProjectNotInSnapshot)
          expect(result.failure).toMatchObject({
            projectId: invalidProjectId,
            generation: snapshot.generation,
          })
        }
      }),
    ),
  )

  effect("rejects file operations for an unknown project", () =>
    withSnapshot((snapshot) =>
      Effect.gen(function* () {
        const invalidProjectId = "missing-project"
        const result = yield* Effect.result(
          Overlay.composeDraft(
            {
              edits: [],
              fileOperations: [
                {
                  kind: "create",
                  projectId: invalidProjectId,
                  path: requireProjectRelativePath("src/new-file.ts"),
                  content: "export {}\n",
                },
              ],
              evidence: [],
              matches: 1,
            },
            Effect.succeed({ edits: [], fileOperations: [], evidence: [], matches: 0 }),
          ),
        )

        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(ProjectNotInSnapshot)
          expect(result.failure).toMatchObject({
            projectId: invalidProjectId,
            generation: snapshot.generation,
          })
        }
      }),
    ),
  )

  effect("folds a later edit into a created file", () =>
    withSnapshot((_, app) =>
      Effect.gen(function* () {
        const snapshot = yield* WorkspaceSnapshot
        const project = yield* snapshot.project(app)
        const created = yield* Draft.files.create(
          project,
          "src/generated.ts",
          "export const generated = 1;\n",
        )
        const composed = yield* Overlay.composeDraft(
          created,
          Effect.gen(function* () {
            const overlaySnapshot = yield* WorkspaceSnapshot
            const overlayProject = yield* overlaySnapshot.project(app)
            const generated = yield* overlayProject.file("src/generated.ts")
            const source = yield* generated.sourceFile
            return yield* Draft.replace(overlayProject, source, source.text.replace("= 1", "= 2"))
          }),
        )
        expect(composed.edits).toHaveLength(0)
        expect(composed.fileOperations).toHaveLength(1)
        expect(composed.fileOperations?.[0]).toMatchObject({
          kind: "create",
          path: "src/generated.ts",
        })
        const createdFile = composed.fileOperations?.[0]
        expect(createdFile?.kind === "create" ? createdFile.content : "").toContain("generated = 2")
      }),
    ),
  )

  effect("folds a move of a created file into one create", () =>
    withSnapshot((_, app) =>
      Effect.gen(function* () {
        const snapshot = yield* WorkspaceSnapshot
        const project = yield* snapshot.project(app)
        const created = yield* Draft.files.create(
          project,
          "src/generated.ts",
          "export const generated = 1;\n",
        )
        const composed = yield* Overlay.composeDraft(
          created,
          Effect.gen(function* () {
            const overlaySnapshot = yield* WorkspaceSnapshot
            const overlayProject = yield* overlaySnapshot.project(app)
            return yield* Draft.files.move(
              overlayProject,
              "src/generated.ts",
              "src/moved-generated.ts",
            )
          }),
        )
        expect(composed.fileOperations).toHaveLength(1)
        expect(composed.fileOperations?.[0]).toMatchObject({
          kind: "create",
          path: "src/moved-generated.ts",
          content: "export const generated = 1;\n",
        })
      }),
    ),
  )

  effect("makes delete of a created file a no-op", () =>
    withSnapshot((_, app) =>
      Effect.gen(function* () {
        const snapshot = yield* WorkspaceSnapshot
        const project = yield* snapshot.project(app)
        const created = yield* Draft.files.create(
          project,
          "src/generated.ts",
          "export const generated = 1;\n",
        )
        const composed = yield* Overlay.composeDraft(
          created,
          Effect.gen(function* () {
            const overlaySnapshot = yield* WorkspaceSnapshot
            const overlayProject = yield* overlaySnapshot.project(app)
            return yield* Draft.files.delete(overlayProject, "src/generated.ts")
          }),
        )
        expect(composed.fileOperations ?? []).toHaveLength(0)
        expect(composed.edits).toHaveLength(0)
      }),
    ),
  )

  effect("turns delete of a moved file into delete of the source", () =>
    withSnapshot((_, app) =>
      Effect.gen(function* () {
        const snapshot = yield* WorkspaceSnapshot
        const project = yield* snapshot.project(app)
        const original = yield* project.sourceText("src/library.ts")
        const moved = yield* Draft.files.move(project, "src/library.ts", "src/moved-library.ts")
        const composed = yield* Overlay.composeDraft(
          moved,
          Effect.gen(function* () {
            const overlaySnapshot = yield* WorkspaceSnapshot
            const overlayProject = yield* overlaySnapshot.project(app)
            return yield* Draft.files.delete(overlayProject, "src/moved-library.ts")
          }),
        )
        expect(composed.fileOperations).toHaveLength(1)
        expect(composed.fileOperations?.[0]).toMatchObject({
          kind: "delete",
          path: "src/library.ts",
          initialHash: textHash(original),
        })
        expect(composed.edits).toHaveLength(0)
      }),
    ),
  )

  effect("queries a moved file on the overlay and rebases the edit into the move", () =>
    withSnapshot((_, app) =>
      Effect.gen(function* () {
        const snapshot = yield* WorkspaceSnapshot
        const project = yield* snapshot.project(app)
        const moved = yield* Draft.files.move(project, "src/library.ts", "src/moved-library.ts")
        const composed = yield* Overlay.composeDraft(
          moved,
          Effect.gen(function* () {
            const overlaySnapshot = yield* WorkspaceSnapshot
            const overlayProject = yield* overlaySnapshot.project(app)
            const overlayFile = yield* overlayProject.file("src/moved-library.ts")
            const source = yield* overlayFile.sourceFile
            return yield* Draft.replace(
              overlayProject,
              source,
              `// edited after move\n${source.text}`,
            )
          }),
        )
        const moveOperation = composed.fileOperations?.find(
          (operation) => operation.kind === "move",
        )
        expect(moveOperation?.kind === "move" ? moveOperation.content : "").toContain(
          "edited after move",
        )
        expect(composed.edits.some((edit) => edit.fileName === "src/moved-library.ts")).toBe(false)
      }),
    ),
  )

  effect("makes delete consume earlier edits to the same file", () =>
    withSnapshot((_, app) =>
      Effect.gen(function* () {
        const snapshot = yield* WorkspaceSnapshot
        const project = yield* snapshot.project(app)
        const library = yield* project.file("src/library.ts")
        const source = yield* library.sourceFile
        const edited = yield* Draft.replace(project, source, `${source.text}\n// transient edit\n`)
        const composed = yield* Overlay.composeDraft(
          edited,
          Effect.gen(function* () {
            const overlaySnapshot = yield* WorkspaceSnapshot
            const overlayProject = yield* overlaySnapshot.project(app)
            return yield* Draft.files.delete(overlayProject, "src/library.ts")
          }),
        )
        expect(composed.fileOperations?.some((operation) => operation.kind === "delete")).toBe(true)
        expect(composed.edits.some((candidate) => candidate.fileName === "src/library.ts")).toBe(
          false,
        )
      }),
    ),
  )

  effect("rejects conflicting evidence ids", () =>
    withSnapshot(() =>
      Effect.gen(function* () {
        const accumulated: DraftModel = {
          edits: [],
          fileOperations: [],
          evidence: [{ id: "shared", kind: "file-operation", facts: { kind: "create" } }],
          matches: 1,
        }
        const next: DraftModel = {
          edits: [],
          fileOperations: [],
          evidence: [{ id: "shared", kind: "file-operation", facts: { kind: "delete" } }],
          matches: 1,
        }
        const result = yield* Overlay.composeDraft(accumulated, Effect.succeed(next)).pipe(
          Effect.result,
        )
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(DraftEvidenceConflict)
        }
      }),
    ),
  )
})
