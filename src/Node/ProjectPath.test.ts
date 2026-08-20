import { path as Path } from "../platform/node.ts"
import { describe, expect, it } from "vitest"
import {
  isWithinProject,
  projectRelativePath,
  resolveContainedSnapshotPath,
  resolveProjectRelativeFile,
} from "./ProjectPath.ts"

describe("Node project paths", () => {
  const root = Path.resolve("/tmp/SafeModsCase/Project")
  const inside = Path.join(root, "src", "index.ts")
  const outside = Path.resolve(root, "..", "Other", "index.ts")

  it("keeps host path operations inside the project", () => {
    expect(isWithinProject(root, inside)).toBe(true)
    expect(isWithinProject(root, root)).toBe(false)
    expect(isWithinProject(root, outside)).toBe(false)
    expect(projectRelativePath(root, inside)).toBe("src/index.ts")
    expect(projectRelativePath(root, Path.join(root, "src", "nested", "value.ts"))).toBe(
      "src/nested/value.ts",
    )
  })

  it("resolves only portable project-relative files", () => {
    expect(resolveProjectRelativeFile(root, "src/index.ts")).toBe(inside)
    expect(resolveProjectRelativeFile(root, "../Other/index.ts")).toBeUndefined()
    expect(resolveProjectRelativeFile(root, outside)).toBeUndefined()
  })

  it("accepts contained absolute snapshot paths", () => {
    expect(resolveContainedSnapshotPath(root, inside)).toBe(inside)
    expect(resolveContainedSnapshotPath(root, outside)).toBeUndefined()
  })
})
