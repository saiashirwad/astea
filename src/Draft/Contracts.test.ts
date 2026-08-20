import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import * as Draft from "../Draft/index.ts"
import { applyFileEdits } from "../Edit/index.ts"
import { requireProjectRelativePath } from "../Plan/index.ts"
import * as Query from "../Query/index.ts"
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import { workspaceLayerNode } from "../Node/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

const expectCompleteEvidence = (draft: Draft.Draft): void => {
  const evidenceIds = draft.evidence.map((record) => record.id)
  expect(new Set(evidenceIds).size).toBe(evidenceIds.length)

  const referencedIds = [
    ...draft.edits.flatMap((edit) => edit.evidenceIds),
    ...(draft.fileOperations ?? []).flatMap((operation) => operation.evidenceIds ?? []),
  ]
  for (const id of referencedIds) {
    expect(evidenceIds.filter((candidate) => candidate === id)).toHaveLength(1)
    expect(draft.evidence.find((record) => record.id === id)?.facts).not.toEqual({})
  }
}

describe("Draft helper contracts", () => {
  effect(
    "aligns replace/wrap matches and gives operation edits complete, unique evidence",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            Fs.writeFile(
              Path.join(root, "src/arguments.ts"),
              [
                "declare function run(...values: Array<number>): number",
                "export const result = run(1, 2, 3)",
                "",
              ].join("\n"),
            ),
          )

          const workspace = yield* Workspace
          yield* workspace.withSnapshot(
            {},
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              const calls = yield* Query.calls(project).pipe(
                Query.within("src/arguments.ts"),
                Query.collect,
              )
              const call = calls.find((selection) => selection.value.arguments.length === 3)?.value
              expect(call).toBeDefined()
              if (call === undefined) return

              const drafts = [
                yield* Draft.replaceArgument(project, call, 0, "10"),
                yield* Draft.wrapArgument(project, call, 0, (text) => `wrapped(${text})`),
                yield* Draft.args.wrap(project, call, 1, (text) => `wrapped(${text})`),
                yield* Draft.args.reorder(project, call, [2, 0, 1]),
                yield* Draft.args.append(project, call, "4"),
              ]
              for (const draft of drafts) {
                expect(draft.matches).toBe(1)
                expect(draft.edits).toHaveLength(1)
                expectCompleteEvidence(draft)
              }
              expectCompleteEvidence(Draft.concat(...drafts))
              expectCompleteEvidence(Draft.concat({ ...drafts[0]!, evidence: [] }))

              const scoped = Draft.forProject(project)
              expect(scoped.audit).toBe(Draft.audit)
              expect(scoped.replaceEach).toBe(Draft.replaceEach)
              expect(scoped.concat).toBe(Draft.concat)
              expect(scoped.imports.organize).toBeTypeOf("function")
              expect(scoped.replaceArgument).toBeTypeOf("function")

              const emptyEach = yield* Draft.replaceEach(calls.slice(0, 1), () => Draft.empty)
              expect(emptyEach.edits).toEqual([])
              expect(emptyEach.matches).toBe(1)
              expect(emptyEach.evidence).toHaveLength(1)
              expect(emptyEach.evidence[0]?.kind).toBe("selection")

              const createEvidence = (projectId: string): Draft.Draft => ({
                edits: [],
                fileOperations: [
                  {
                    kind: "create",
                    projectId,
                    path: requireProjectRelativePath("src/a.ts"),
                    content: projectId,
                    evidenceIds: [`file:create:${projectId}:src/a.ts`],
                  },
                ],
                evidence: [
                  {
                    id: `file:create:${projectId}:src/a.ts`,
                    kind: "file-operation",
                    facts: { kind: "create", projectId, path: "src/a.ts" },
                  },
                ],
                matches: 1,
              })
              const mergedProjects = Draft.concat(createEvidence("app"), createEvidence("lib"))
              expect(mergedProjects.evidence.map((record) => record.id).sort()).toEqual([
                "file:create:app:src/a.ts",
                "file:create:lib:src/a.ts",
              ])
              const sameTwice = Draft.concat(createEvidence("app"), createEvidence("app"))
              expect(sameTwice.evidence).toHaveLength(1)
              expect(() =>
                Draft.concat(createEvidence("app"), {
                  ...createEvidence("app"),
                  evidence: [
                    {
                      id: "file:create:app:src/a.ts",
                      kind: "file-operation",
                      facts: { kind: "delete", projectId: "app", path: "src/a.ts" },
                    },
                  ],
                }),
              ).toThrow(Draft.DraftEvidenceConflict)

              const sameRange = calls[0]!
              const firstAudit = Draft.audit([sameRange])
              const secondSelection = {
                ...sameRange,
                evidence: [{ criterion: "other", facts: { extra: true } }],
              }
              expect(() => Draft.audit([sameRange, secondSelection])).toThrow(
                Draft.DraftEvidenceConflict,
              )
              const sameAudit = Draft.audit([sameRange, sameRange])
              expect(sameAudit.matches).toBe(1)
              expect(sameAudit.evidence).toHaveLength(1)
              expect(firstAudit.evidence[0]?.id).toBe(sameAudit.evidence[0]?.id)

              const conflictingEach = yield* Draft.replaceEach(calls.slice(0, 1), (selection) => ({
                edits: [],
                evidence: [
                  {
                    id: `selection:${selection.project.project.id}:${selection.fileName}:${selection.start}-${selection.end}`,
                    kind: "selection",
                    facts: { other: true },
                  },
                ],
                matches: 1,
              })).pipe(Effect.flip)
              expect(conflictingEach._tag).toBe("DraftEvidenceConflict")
            }),
          )
        }),
      ),
    60_000,
  )

  effect(
    "returns Draft.empty for missing arguments and invalid reorder permutations",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            Fs.writeFile(
              Path.join(root, "src/reorder.ts"),
              [
                "declare function run(...values: Array<number>): number",
                "export const result = run(1, 2, 3)",
                "",
              ].join("\n"),
            ),
          )

          const workspace = yield* Workspace
          yield* workspace.withSnapshot(
            {},
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              const calls = yield* Query.calls(project).pipe(
                Query.within("src/reorder.ts"),
                Query.collect,
              )
              const call = calls.find((selection) => selection.value.arguments.length === 3)?.value
              expect(call).toBeDefined()
              if (call === undefined) return

              expect(yield* Draft.replaceArgument(project, call, 9, "missing")).toEqual(Draft.empty)
              expect(yield* Draft.wrapArgument(project, call, 9, (text) => text)).toEqual(
                Draft.empty,
              )

              const invalidIndices = [
                [0, 0, 2],
                [0, 1, 3],
                [-1, 1, 2],
                [0, 1],
                [0, 1, 1.5],
                [0, 1, 2],
              ]
              for (const indices of invalidIndices) {
                expect(yield* Draft.args.reorder(project, call, indices)).toEqual(Draft.empty)
              }
            }),
          )
        }),
      ),
    60_000,
  )

  effect(
    "does not reprint unsupported imports and preserves supported quote style",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          const sources = new Map([
            [
              "type-only.ts",
              'import type { Shape } from "./types.js";\nexport type Value = Shape\n',
            ],
            ["side-effect.ts", 'import "./setup.js";\nexport const value = 1\n'],
            ["namespace.ts", 'import * as values from "./values.js";\nexport { values }\n'],
            ["trivia.ts", 'import { /* keep */ value } from "./values.js";\nexport { value }\n'],
          ])
          for (const [fileName, source] of sources) {
            yield* Effect.tryPromise(() => Fs.writeFile(Path.join(root, "src", fileName), source))
          }
          const quotedSource = [
            "import { zed } from './zed.js';",
            "import { alpha } from './alpha.js';",
            "",
            "export { alpha, zed }",
            "",
          ].join("\n")
          yield* Effect.tryPromise(() =>
            Fs.writeFile(Path.join(root, "src/quoted.ts"), quotedSource),
          )

          const workspace = yield* Workspace
          yield* workspace.withSnapshot(
            {},
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              for (const fileName of sources.keys()) {
                expect(yield* Draft.imports.organize(project, `src/${fileName}`)).toEqual(
                  Draft.empty,
                )
              }

              const quoted = yield* Draft.imports.organize(project, "src/quoted.ts")
              expectCompleteEvidence(quoted)
              const output = yield* applyFileEdits(quotedSource, quoted.edits)
              expect(output).toContain("import { alpha } from './alpha.js';")
              expect(output).toContain("import { zed } from './zed.js';")
              expect(output.endsWith("export { alpha, zed }\n")).toBe(true)
            }),
          )
        }),
      ),
    60_000,
  )

  effect(
    "cleanUnused removes only an unused named binding and does not target it on a second run",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          const consumerPath = Path.join(root, "src/default-consumer.ts")
          yield* Effect.tryPromise(() =>
            Fs.writeFile(
              Path.join(root, "src/default-module.ts"),
              [
                "export default function DefaultThing(): number { return 1 }",
                "export const Unused = 2",
                "",
              ].join("\n"),
            ),
          )
          const original = [
            'import DefaultThing, { Unused } from "./default-module.js";',
            "export const value = DefaultThing()",
            "",
          ].join("\n")
          yield* Effect.tryPromise(() => Fs.writeFile(consumerPath, original))

          const workspace = yield* Workspace
          const output = yield* workspace.withSnapshot(
            {},
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              const draft = yield* Draft.cleanUnused(project)
              expectCompleteEvidence(draft)
              return yield* applyFileEdits(
                original,
                draft.edits.filter((edit) => edit.fileName === "src/default-consumer.ts"),
              )
            }),
          )
          expect(output).toContain('import DefaultThing from "./default-module.js";')
          expect(output).not.toContain("Unused")
          yield* Effect.tryPromise(() => Fs.writeFile(consumerPath, output))

          const second = yield* Effect.gen(function* () {
            const refreshedWorkspace = yield* Workspace
            return yield* refreshedWorkspace.withSnapshot(
              {},
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.cleanUnused(project)
              }),
            )
          }).pipe(Effect.provide(workspaceLayerNode({ projects: [app] }, { cwd: root })))
          expect(
            second.edits.filter((edit) => edit.fileName === "src/default-consumer.ts"),
          ).toEqual([])
        }),
      ),
    60_000,
  )
})
