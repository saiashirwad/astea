import { describe, effect, expect } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { applyFileEdits, makeTextEdit, normalizeEdits, textHash, type TextEdit } from "./index.ts"

const edit = (start: number, end: number, newText: string): TextEdit => ({
  projectId: "app",
  fileName: "src/index.ts",
  start,
  end,
  newText,
  expectedTextHash: textHash("abcdef".slice(start, end)),
  evidenceIds: [],
})

describe("Edit", () => {
  effect("sorts edits deterministically", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeEdits([edit(4, 5, "E"), edit(1, 2, "B")])
      expect(normalized.map((item) => item.start)).toEqual([1, 4])
    }),
  )

  effect("rejects insertions at the same position and overlapping replacements", () =>
    Effect.gen(function* () {
      const insertion = yield* Effect.exit(normalizeEdits([edit(2, 2, "x"), edit(2, 2, "y")]))
      const overlap = yield* Effect.exit(normalizeEdits([edit(1, 4, "x"), edit(3, 5, "y")]))
      expect(Exit.isFailure(insertion)).toBe(true)
      expect(Exit.isFailure(overlap)).toBe(true)
    }),
  )

  effect("guards expected source text", () =>
    Effect.gen(function* () {
      const guarded = makeTextEdit({
        projectId: "app",
        fileName: "src/index.ts",
        sourceText: "abcdef",
        start: 1,
        end: 3,
        newText: "BC",
      })
      expect(yield* applyFileEdits("abcdef", [guarded])).toBe("aBCdef")
      expect(Exit.isFailure(yield* Effect.exit(applyFileEdits("axcdef", [guarded])))).toBe(true)
    }),
  )
})
