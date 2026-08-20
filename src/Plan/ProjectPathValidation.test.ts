import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import { parseProjectRelativePath } from "../ProjectPath/index.ts"

describe("plan project path validation", () => {
  effect("rejects unsafe project-relative path spellings", () =>
    Effect.sync(() => {
      for (const path of [
        "../escape.ts",
        "/tmp/file.ts",
        "C:\\tmp\\file.ts",
        "C:/tmp/file.ts",
        "\\\\server\\share\\file.ts",
        "//server/share/file.ts",
        "bad\0name.ts",
      ]) {
        expect(parseProjectRelativePath(path)).toBeUndefined()
      }
      expect(parseProjectRelativePath("src/../src/index.ts")).toBe("src/index.ts")
    }),
  )
})
