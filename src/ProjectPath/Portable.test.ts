import { describe, expect, it } from "vitest"
import {
  InvalidProjectRelativePath,
  isProjectRelativePath,
  parseProjectRelativePath,
  requireProjectRelativePath,
} from "./index.ts"

describe("portable project paths", () => {
  it("normalizes portable relative paths", () => {
    expect(parseProjectRelativePath("./src\\feature/../index.ts")).toBe("src/index.ts")
    expect(parseProjectRelativePath("src//index.ts")).toBe("src/index.ts")
    expect(isProjectRelativePath("src/index.ts")).toBe(true)
    expect(isProjectRelativePath("./src/index.ts")).toBe(false)
  })

  it.each([
    "",
    ".",
    "..",
    "../index.ts",
    "/src/index.ts",
    "\\server\\share\\index.ts",
    "C:\\src\\index.ts",
    "src/device:name.ts",
    "src/\0index.ts",
  ])("rejects nonportable path %j", (path) => {
    expect(parseProjectRelativePath(path)).toBeUndefined()
  })

  it("reports the rejected input", () => {
    expect(() => requireProjectRelativePath("../index.ts")).toThrow(
      new InvalidProjectRelativePath({ path: "../index.ts" }),
    )
  })
})
