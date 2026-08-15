import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { TokenFlags } from "typescript/unstable/ast"
import { createNumericLiteral, updateCallExpression } from "typescript/unstable/ast/factory"
import { describe, expect, it } from "vitest"
import {
  applyFileEdits,
  EditConflict,
  makeTextEdit,
  normalizeEdits,
  printNativeFragment,
} from "./edits.ts"
import { calls, collect } from "./semantic-query.ts"
import { ConfiguredProject, layer, Workspace, WorkspaceSnapshot } from "./workspace-snapshot.ts"

const fixtureRoot = fileURLToPath(new URL("../../fixtures/query/", import.meta.url))

describe("edit and source fidelity prototype", () => {
  it("changes only the requested range and preserves unrelated bytes", async () => {
    const source = "// header\r\nconst  x = foo( 1 ) // tail\r\n"
    const start = source.indexOf("foo( 1 )")
    const edit = makeTextEdit({
      projectConfigFileName: "/project/tsconfig.json",
      fileName: "src/index.ts",
      sourceText: source,
      start,
      end: start + "foo( 1 )".length,
      newText: "foo(2)",
      evidence: ["selected-call"],
    })

    await expect(Effect.runPromise(applyFileEdits(source, [edit])))
      .resolves.toBe("// header\r\nconst  x = foo(2) // tail\r\n")
  })

  it("rejects overlapping ranges and ambiguous same-position insertions", async () => {
    const source = "abcdef"
    const make = (start: number, end: number, newText: string) => makeTextEdit({
      projectConfigFileName: "/project/tsconfig.json",
      fileName: "src/index.ts",
      sourceText: source,
      start,
      end,
      newText,
    })

    const overlap = await Effect.runPromiseExit(normalizeEdits([make(1, 4, "x"), make(3, 5, "y")]))
    const insert = await Effect.runPromiseExit(normalizeEdits([make(2, 2, "x"), make(2, 2, "y")]))

    expect(overlap._tag).toBe("Failure")
    expect(insert._tag).toBe("Failure")
    if (overlap._tag === "Failure") expect(String(overlap.cause)).toContain(EditConflict.name)
  })

  it("uses the native emitter for a synthesized replacement fragment", async () => {
    const configured = ConfiguredProject.make(Path.join(fixtureRoot, "tsconfig.json"))
    const printed = await Effect.runPromise(Workspace.use((workspace) => workspace.withSnapshot(
      {},
      Effect.gen(function*() {
        const snapshot = yield* WorkspaceSnapshot
        const project = yield* snapshot.project(configured)
        const call = (yield* calls(project).pipe(collect))[0]!.value
        const updated = updateCallExpression(
          call,
          call.expression,
          call.questionDotToken,
          call.typeArguments,
          [createNumericLiteral("42", TokenFlags.None)],
        )
        return yield* printNativeFragment(project, updated)
      }),
    )).pipe(Effect.provide(layer({ projects: [configured] }, { cwd: fixtureRoot }))))

    expect(printed).toContain("(42)")
  })
})
