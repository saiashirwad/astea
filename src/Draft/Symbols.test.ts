import { describe, effect, expect } from "@effect/vitest"
import { Effect, Option } from "effect"
import { applyFileEdits } from "../Edit/index.ts"
import { withProject } from "../test/project-fixture.ts"
import * as Draft from "./index.ts"

describe("Draft symbol renaming", () => {
  effect(
    "renameSymbol rewrites every identifier that canonically resolves to the symbol",
    () =>
      withProject({}, (project) =>
        Effect.gen(function* () {
          const symbolOption = yield* project.findSymbolNamed("target", {
            within: "src/library.ts",
          })
          if (Option.isNone(symbolOption)) return expect.unreachable("symbol not found")

          const draft = yield* Draft.renameSymbol(project, symbolOption.value, "renamedTarget")
          expect(draft.matches).toBeGreaterThan(0)
          expect(draft.edits.every((edit) => edit.newText === "renamedTarget")).toBe(true)

          const files = new Set(draft.edits.map((edit) => edit.fileName))
          // Declaration, aliased import usage, re-export declaration and
          // usage all resolve to the same canonical symbol.
          expect(files).toEqual(
            new Set([
              "src/barrel.ts",
              "src/consumer.ts",
              "src/library.ts",
              "src/reexport-consumer.ts",
            ]),
          )

          const applyTo = (fileName: string) =>
            Effect.gen(function* () {
              const source = yield* project.sourceText(fileName)
              return yield* applyFileEdits(
                source,
                draft.edits.filter((edit) => edit.fileName === fileName),
              )
            })

          const libraryOutput = yield* applyTo("src/library.ts")
          expect(libraryOutput).toContain("export function renamedTarget(")

          const consumerOutput = yield* applyTo("src/consumer.ts")
          expect(consumerOutput).toContain("renamedTarget(/* keep this comment */ 1)")
          // A same-name property on a local object is a different symbol.
          expect(consumerOutput).toContain("local.target(3)")
          // Alias bindings collapse to the new name: the author's chosen
          // local alias `renamed` is rewritten in both clause and usage.
          expect(consumerOutput).toContain(
            'import { other, renamedTarget as renamedTarget } from "./library.js"',
          )

          // The public re-export alias `publicTarget` is likewise collapsed,
          // changing the module's exported name.
          const barrelOutput = yield* applyTo("src/barrel.ts")
          expect(barrelOutput).toBe(
            'export { renamedTarget as renamedTarget } from "./library.js"\n',
          )

          const reexportOutput = yield* applyTo("src/reexport-consumer.ts")
          expect(reexportOutput).toContain('import { renamedTarget } from "./barrel.js"')
          expect(reexportOutput).toContain("renamedTarget(4)")
        }),
      ),
    60_000,
  )

  effect(
    "renameSymbolNamed is idempotent when the symbol does not exist",
    () =>
      withProject({}, (project) =>
        Effect.gen(function* () {
          const draft = yield* Draft.renameSymbolNamed(project, "nonexistent", "whatever", {
            within: "src/library.ts",
          })
          expect(draft.edits).toEqual([])
          expect(draft.matches).toBe(0)
        }),
      ),
    60_000,
  )

  effect(
    "renameSymbolNamed scopes the symbol lookup to a file but renames across the project",
    () =>
      withProject({}, (project) =>
        Effect.gen(function* () {
          const files = yield* project.files
          const library = files.find((file) => file.path === "src/library.ts")
          expect(library).toBeDefined()

          // `other` is declared in library.ts and used in consumer.ts; the
          // file argument only scopes where the symbol is found by name.
          const draft = yield* Draft.renameSymbolNamed(library!, "other", "renamedOther")
          expect(draft.edits.map((edit) => edit.fileName).sort()).toEqual([
            "src/consumer.ts",
            "src/consumer.ts",
            "src/library.ts",
          ])
          expect(draft.edits.every((edit) => edit.newText === "renamedOther")).toBe(true)
        }),
      ),
    60_000,
  )
})
