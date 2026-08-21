import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import type { PlannedFileOperation } from "../Plan/index.ts"
import { applyFileEdits } from "../Edit/index.ts"
import { textHash } from "../Edit/Hash.ts"
import { withProject } from "../test/project-fixture.ts"
import * as Draft from "./index.ts"

/** Narrow a file operation to its variant, failing the test on any other kind. */
const expectKind = <K extends PlannedFileOperation["kind"]>(
  operation: PlannedFileOperation,
  kind: K,
): Extract<PlannedFileOperation, { readonly kind: K }> => {
  expect(operation.kind).toBe(kind)
  // SAFETY: the preceding assertion pins operation.kind to K, so the
  // discriminated union narrows to exactly this variant at runtime.
  return operation as Extract<PlannedFileOperation, { readonly kind: K }>
}

describe("Draft.files", () => {
  effect(
    "create proposes a create operation with complete evidence",
    () =>
      withProject({}, (project) =>
        Effect.gen(function* () {
          const draft = yield* Draft.files.create(project, "src/new.ts", "export const n = 1\n")
          expect(draft.edits).toEqual([])
          expect(draft.matches).toBe(1)
          expect(draft.fileOperations).toHaveLength(1)
          const operation = expectKind(draft.fileOperations![0]!, "create")
          expect(operation.path).toBe("src/new.ts")
          expect(operation.content).toBe("export const n = 1\n")

          expect(draft.evidence).toHaveLength(1)
          const record = draft.evidence[0]!
          expect(record.kind).toBe("file-operation")
          expect(record.facts.kind).toBe("create")
          expect(record.id).toBe(operation.evidenceIds?.[0])
        }),
      ),
    60_000,
  )

  effect(
    "delete proposes a delete operation guarded by the current content hash",
    () =>
      withProject({}, (project) =>
        Effect.gen(function* () {
          const source = yield* project.sourceText("src/library.ts")
          const draft = yield* Draft.files.delete(project, "src/library.ts")
          const operation = expectKind(draft.fileOperations![0]!, "delete")
          expect(operation.path).toBe("src/library.ts")
          expect(operation.initialHash).toBe(textHash(source))
          expect(draft.evidence[0]!.id).toBe(operation.evidenceIds?.[0])
        }),
      ),
    60_000,
  )

  effect(
    "move rewrites importer specifiers, normalizing those that already resolve",
    () =>
      withProject(
        {
          "src/lib.ts": "export const A = 1\n",
          "src/user.ts": 'import { A } from "./lib.js";\nexport const value = A;\n',
          "src/nested/inner.ts": 'import { A } from "../lib.js";\nexport const inner = A;\n',
        },
        (project) =>
          Effect.gen(function* () {
            const userSource = yield* project.sourceText("src/user.ts")
            const innerSource = yield* project.sourceText("src/nested/inner.ts")
            const draft = yield* Draft.files.move(project, "src/lib.ts", "src/nested/lib.ts")

            const operation = expectKind(draft.fileOperations![0]!, "move")
            expect(operation.path).toBe("src/lib.ts")
            expect(operation.toPath).toBe("src/nested/lib.ts")

            // src/user.ts needs a real rewrite. src/nested/inner.ts still
            // resolved via "../lib.js", but the engine normalizes any rendered
            // specifier that differs textually from the shortest relative form.
            expect(draft.edits.map((edit) => edit.fileName)).toEqual([
              "src/user.ts",
              "src/nested/inner.ts",
            ])

            const userOutput = yield* applyFileEdits(userSource, [draft.edits[0]!])
            expect(userOutput).toContain('from "./nested/lib.js"')

            const innerOutput = yield* applyFileEdits(innerSource, [draft.edits[1]!])
            expect(innerOutput).toContain('from "./lib.js"')
          }),
      ),
    60_000,
  )

  effect(
    "move carries the moved file's rewritten imports in the operation content, not as edits",
    () =>
      withProject(
        {
          "src/lib.ts": "export const A = 1\n",
          "src/host.ts": 'import { A } from "./lib.js";\nexport const h = A;\n',
        },
        (project) =>
          Effect.gen(function* () {
            const draft = yield* Draft.files.move(project, "src/host.ts", "src/nested/host.ts")

            // The file moves wholesale, so its own specifier rewrites ride in
            // the move operation's content instead of Text Edits.
            expect(draft.edits).toEqual([])
            const operation = expectKind(draft.fileOperations![0]!, "move")
            expect(operation.content).toContain('from "../lib.js"')
            expect(operation.content).toContain("export const h = A;")
          }),
      ),
    60_000,
  )
})
