import { nodeFsPromises as Fs } from "../platform/node.ts"
import { fileURLToPath } from "node:url"
import { effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import { applyFileEdits, textHash, type TextEdit } from "../Edit/index.ts"
import type { Draft } from "../Draft/index.ts"
import {
  ConfiguredProject,
  ProjectNotInSnapshot,
  Workspace,
  WorkspaceSnapshot,
  type WorkspaceSnapshotService,
} from "../Workspace/index.ts"
import { requireProjectRelativePath } from "../ProjectPath/index.ts"
import { workspaceLayerNode } from "../Node/index.ts"
import { composeDrafts } from "./DraftComposition.ts"

const fixtureSource = fileURLToPath(new URL("../../fixtures/recipe/", import.meta.url))

const withSnapshot = <A, E>(
  use: (snapshot: WorkspaceSnapshotService) => Effect.Effect<A, E>,
): Effect.Effect<A, unknown> =>
  Effect.acquireUseRelease(
    Effect.tryPromise(async () => {
      const root = await Fs.mkdtemp("/tmp/safemods-draft-composition-")
      await Fs.cp(fixtureSource, root, { recursive: true })
      return root
    }),
    (root) => {
      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
      const layer = workspaceLayerNode({ projects: [app] }, { cwd: root })
      return Effect.gen(function* () {
        const workspace = yield* Workspace
        return yield* workspace.withSnapshot(
          {},
          Effect.gen(function* () {
            const snapshot = yield* WorkspaceSnapshot
            return yield* use(snapshot)
          }),
        )
      }).pipe(Effect.provide(layer))
    },
    (root) =>
      Effect.tryPromise(() => Fs.rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
  )

const evidence = (id: string) => ({ id, kind: "test", facts: { id } })

effect("composeDrafts collapses distant sequential edits against the original text", () =>
  withSnapshot((snapshot) =>
    Effect.gen(function* () {
      const configured = snapshot.projects[0]!
      const project = yield* snapshot.project(configured)
      const original = yield* project.sourceText("src/consumer.ts")
      const firstStart = original.indexOf("renamed")
      const first: TextEdit = {
        projectId: configured.id,
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
        projectId: configured.id,
        fileName: "src/consumer.ts",
        start: secondStart,
        end: secondStart + "other(2)".length,
        expectedTextHash: textHash("other(2)"),
        newText: "other(20)",
        evidenceIds: ["second"],
      }
      const expected = yield* applyFileEdits(intermediate, [second])
      const accumulated: Draft = {
        edits: [first],
        fileOperations: [],
        evidence: [evidence("first")],
        matches: 1,
      }
      const next: Draft = {
        edits: [second],
        fileOperations: [],
        evidence: [evidence("second")],
        matches: 1,
      }

      const composed = yield* composeDrafts(snapshot, accumulated, next)
      expect(yield* applyFileEdits(original, composed.edits)).toBe(expected)
      expect(composed.matches).toBe(2)
      expect(composed.evidence.map((item) => item.id)).toEqual(["first", "second"])
    }),
  ),
)

effect("composeDrafts puts a later edit into moved file content", () =>
  withSnapshot((snapshot) =>
    Effect.gen(function* () {
      const configured = snapshot.projects[0]!
      const project = yield* snapshot.project(configured)
      const original = yield* project.sourceText("src/consumer.ts")
      const editStart = original.indexOf("other(2)")
      const edit: TextEdit = {
        projectId: configured.id,
        fileName: "src/moved.ts",
        start: editStart,
        end: editStart + "other(2)".length,
        expectedTextHash: textHash("other(2)"),
        newText: "other(20)",
        evidenceIds: ["edit"],
      }
      const expected = yield* applyFileEdits(original, [edit])
      const accumulated: Draft = {
        edits: [],
        fileOperations: [
          {
            kind: "move",
            projectId: configured.id,
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
      const next: Draft = {
        edits: [edit],
        fileOperations: [],
        evidence: [evidence("edit")],
        matches: 1,
      }

      const composed = yield* composeDrafts(snapshot, accumulated, next)
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

effect("composeDrafts rejects sequential edits for an unknown project", () =>
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
        composeDrafts(
          snapshot,
          { edits: [first], fileOperations: [], evidence: [], matches: 1 },
          { edits: [second], fileOperations: [], evidence: [], matches: 1 },
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

effect("composeDrafts rejects file operations for an unknown project", () =>
  withSnapshot((snapshot) =>
    Effect.gen(function* () {
      const invalidProjectId = "missing-project"
      const result = yield* Effect.result(
        composeDrafts(
          snapshot,
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
          { edits: [], fileOperations: [], evidence: [], matches: 0 },
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
