import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "vitest"
import {
  checkArchitectureBoundaries,
  dependencyFailure,
  temporaryAdapterImports,
} from "./check-boundaries.mjs"

describe("architecture boundaries", () => {
  it("allows downward dependencies and rejects removed adapter migrations", () => {
    assert.equal(dependencyFailure("Draft", "Query"), undefined)
    assert.equal(dependencyFailure("Verification", "Plan"), undefined)
    assert.equal(dependencyFailure("Workspace", "Node"), "Workspace must not depend on Node")
    assert.equal(temporaryAdapterImports.has("Workspace"), false)
  })

  it("rejects upward and restricted semantic dependencies", () => {
    assert.equal(dependencyFailure("Edit", "Workspace"), "Edit imports higher layer Workspace")
    assert.equal(dependencyFailure("Pattern", "Query"), "Pattern must not depend on Query")
    assert.equal(dependencyFailure("Workspace", "Draft"), "Workspace must not depend on Draft")
    assert.equal(
      dependencyFailure("Recipe", "Application"),
      "Recipe must not depend on Application",
    )
    assert.equal(dependencyFailure("Preview", "Execution"), "Preview must not depend on Execution")
    assert.equal(
      dependencyFailure("Verification", "Application"),
      "Verification must not depend on Application",
    )
  })

  it("checks static, dynamic, private, root, and package imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "safemods-boundaries-"))
    try {
      await Promise.all([
        mkdir(join(root, "bin"), { recursive: true }),
        mkdir(join(root, "src", "Draft"), { recursive: true }),
        mkdir(join(root, "src", "Edit"), { recursive: true }),
        mkdir(join(root, "src", "Pattern"), { recursive: true }),
        mkdir(join(root, "src", "Preview"), { recursive: true }),
        mkdir(join(root, "src", "Query", "internal"), { recursive: true }),
        mkdir(join(root, "src", "Recipe"), { recursive: true }),
        mkdir(join(root, "src", "Application"), { recursive: true }),
        mkdir(join(root, "src", "Execution"), { recursive: true }),
        mkdir(join(root, "src", "Verification"), { recursive: true }),
        mkdir(join(root, "src", "Workspace"), { recursive: true }),
        mkdir(join(root, "src", "Node"), { recursive: true }),
      ])
      await Promise.all([
        writeFile(join(root, "bin", "safemods.ts"), 'import "../src/Cli/index.ts"\n'),
        writeFile(join(root, "src", "index.ts"), 'export * as Query from "./Query/index.ts"\n'),
        writeFile(join(root, "src", "Query", "index.ts"), "export {}\n"),
        writeFile(join(root, "src", "Workspace", "index.ts"), "export {}\n"),
        writeFile(
          join(root, "src", "Workspace", "ProjectPath.ts"),
          'export { projectRelativePath } from "../Node/ProjectPath.ts"\n',
        ),
        writeFile(join(root, "src", "Workspace", "Bad.ts"), 'import "../Node/ProjectPath.ts"\n'),
        writeFile(join(root, "src", "Node", "ProjectPath.ts"), "export {}\n"),
        writeFile(
          join(root, "src", "Edit", "Bad.ts"),
          'import "../Workspace/index.ts"\nimport "safemods/Plan"\n',
        ),
        writeFile(
          join(root, "src", "Pattern", "Bad.ts"),
          'import "../Query/internal/Private.ts"\n',
        ),
        writeFile(
          join(root, "src", "Recipe", "Bad.ts"),
          'import("../Cli/index.ts")\nimport "../Application/index.ts"\nimport "../index.ts"\n',
        ),
        writeFile(join(root, "src", "Preview", "Bad.ts"), 'import "../Execution/index.ts"\n'),
        writeFile(
          join(root, "src", "Verification", "Bad.ts"),
          'import "../Application/index.ts"\n',
        ),
        writeFile(join(root, "src", "Application", "index.ts"), "export {}\n"),
        writeFile(join(root, "src", "Execution", "index.ts"), "export {}\n"),
        writeFile(join(root, "src", "Draft", "Good.ts"), 'import "../Query/index.ts"\n'),
      ])

      const failures = await checkArchitectureBoundaries(root)
      assert.ok(failures.some((failure) => failure.includes("Edit imports higher layer Workspace")))
      assert.ok(failures.some((failure) => failure.includes("package self-import safemods/Plan")))
      assert.ok(failures.some((failure) => failure.includes("imports private")))
      assert.ok(failures.some((failure) => failure.includes("Recipe must not depend on Cli")))
      assert.ok(
        failures.some((failure) => failure.includes("Recipe must not depend on Application")),
      )
      assert.ok(
        failures.some((failure) => failure.includes("Preview must not depend on Execution")),
      )
      assert.ok(
        failures.some((failure) => failure.includes("Verification must not depend on Application")),
      )
      assert.ok(failures.some((failure) => failure.includes("imports the root façade")))
      assert.equal(
        failures.some((failure) => failure.includes("Draft/Good.ts")),
        false,
      )
      assert.equal(
        failures.some((failure) => failure.includes("Workspace/ProjectPath.ts")),
        false,
      )
      assert.ok(
        failures.some((failure) =>
          failure.includes("Workspace/Bad.ts: Workspace must not depend on Node"),
        ),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
