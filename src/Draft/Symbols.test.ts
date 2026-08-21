import { describe, effect, expect } from "@effect/vitest"
import { Effect, Option } from "effect"
import { applyFileEdits } from "../Edit/index.ts"
import { withProject } from "../test/project-fixture.ts"
import * as Draft from "./index.ts"

describe("Draft symbol renaming", () => {
  effect(
    "renameSymbol follows the symbol but preserves chosen alias names",
    () =>
      withProject({}, (project) =>
        Effect.gen(function* () {
          const symbolOption = yield* project.findSymbolNamed("target", {
            within: "src/library.ts",
          })
          if (Option.isNone(symbolOption)) return expect.unreachable("symbol not found")

          const draft = yield* Draft.renameSymbol(project, symbolOption.value, "renamedTarget")
          // One edit per touched file: declaration, import property, and
          // re-export property. The downstream consumer of the preserved
          // public name needs no edit at all.
          expect(draft.edits.map((edit) => edit.fileName).sort()).toEqual([
            "src/barrel.ts",
            "src/consumer.ts",
            "src/library.ts",
          ])

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

          // The consumer's chosen local alias `renamed` survives, so its call
          // sites need no edits at all.
          const consumerOutput = yield* applyTo("src/consumer.ts")
          expect(consumerOutput).toContain(
            'import { other, renamedTarget as renamed } from "./library.js"',
          )
          expect(consumerOutput).toContain("renamed(/* keep this comment */ 1)")
          // A same-name property on a local object is a different symbol.
          expect(consumerOutput).toContain("local.target(3)")

          // The module's public export name is preserved.
          const barrelOutput = yield* applyTo("src/barrel.ts")
          expect(barrelOutput).toBe(
            'export { renamedTarget as publicTarget } from "./library.js"\n',
          )

          // Downstream consumers of the preserved public name are untouched:
          // barrel still exports `publicTarget`, so nothing breaks.
          const reexportSource = yield* project.sourceText("src/reexport-consumer.ts")
          const reexportOutput = yield* applyTo("src/reexport-consumer.ts")
          expect(reexportOutput).toBe(reexportSource)
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
            lookupIn: "src/library.ts",
          })
          expect(draft.edits).toEqual([])
          expect(draft.matches).toBe(0)
        }),
      ),
    60_000,
  )

  effect(
    "renameSymbolNamed locates the symbol by file but renames across the project",
    () =>
      withProject({}, (project) =>
        Effect.gen(function* () {
          const files = yield* project.files
          const library = files.find((file) => file.path === "src/library.ts")
          expect(library).toBeDefined()

          // `other` is declared in library.ts and imported by consumer.ts.
          // The ProjectFile only scopes where the name is looked up; the
          // rename follows the symbol everywhere it would otherwise break.
          const draft = yield* Draft.renameSymbolNamed(library!, "other", "renamedOther")
          expect(draft.edits.map((edit) => edit.fileName).sort()).toEqual([
            "src/consumer.ts",
            "src/library.ts",
          ])
          expect(draft.edits.every((edit) => edit.newText.includes("renamedOther"))).toBe(true)

          const consumerSource = yield* project.sourceText("src/consumer.ts")
          const consumerOutput = yield* applyFileEdits(
            consumerSource,
            draft.edits.filter((edit) => edit.fileName === "src/consumer.ts"),
          )
          // The plain named import keeps its local binding via an alias, so
          // the usage below stays valid without any edit.
          expect(consumerOutput).toContain("import { renamedOther as other,")
          expect(consumerOutput).toContain("other(2)")
        }),
      ),
    60_000,
  )
})
