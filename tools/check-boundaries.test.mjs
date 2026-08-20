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
  it("allows downward dependencies and named adapter migrations", () => {
    assert.equal(dependencyFailure("Draft", "Query"), undefined)
    assert.equal(dependencyFailure("Verification", "Plan"), undefined)
    assert.equal(dependencyFailure("Workspace", "Node"), undefined)
    assert.equal(temporaryAdapterImports.get("Workspace")?.has("Node"), true)
  })

  it("rejects upward and restricted semantic dependencies", () => {
    assert.equal(dependencyFailure("Edit", "Workspace"), "Edit imports higher layer Workspace")
    assert.equal(dependencyFailure("Pattern", "Query"), "Pattern must not depend on Query")
    assert.equal(dependencyFailure("Workspace", "Draft"), "Workspace must not depend on Draft")
  })

  it("checks static, dynamic, private, root, and package imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "safemods-boundaries-"))
    try {
      await Promise.all([
        mkdir(join(root, "bin"), { recursive: true }),
        mkdir(join(root, "src", "Draft"), { recursive: true }),
        mkdir(join(root, "src", "Edit"), { recursive: true }),
        mkdir(join(root, "src", "Pattern"), { recursive: true }),
        mkdir(join(root, "src", "Query", "internal"), { recursive: true }),
        mkdir(join(root, "src", "Recipe"), { recursive: true }),
        mkdir(join(root, "src", "Workspace"), { recursive: true }),
      ])
      await Promise.all([
        writeFile(join(root, "bin", "safemods.ts"), 'import "../src/Cli/index.ts"\n'),
        writeFile(join(root, "src", "index.ts"), 'export * as Query from "./Query/index.ts"\n'),
        writeFile(join(root, "src", "Query", "index.ts"), "export {}\n"),
        writeFile(join(root, "src", "Workspace", "index.ts"), "export {}\n"),
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
          'import("../Cli/index.ts")\nimport "../index.ts"\n',
        ),
        writeFile(join(root, "src", "Draft", "Good.ts"), 'import "../Query/index.ts"\n'),
      ])

      const failures = await checkArchitectureBoundaries(root)
      assert.ok(failures.some((failure) => failure.includes("Edit imports higher layer Workspace")))
      assert.ok(failures.some((failure) => failure.includes("package self-import safemods/Plan")))
      assert.ok(failures.some((failure) => failure.includes("imports private")))
      assert.ok(failures.some((failure) => failure.includes("Recipe imports higher layer Cli")))
      assert.ok(failures.some((failure) => failure.includes("imports the root façade")))
      assert.equal(
        failures.some((failure) => failure.includes("Draft/Good.ts")),
        false,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
