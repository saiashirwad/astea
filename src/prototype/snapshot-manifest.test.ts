import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ConfiguredProject, layer, Workspace, WorkspaceSnapshot } from "./workspace-snapshot.ts"

const fixtureRoot = fileURLToPath(new URL("../../fixtures/stress/", import.meta.url))

describe("snapshot input manifest feasibility", () => {
  it("observes filesystem reads and resolution probes through the native adapter", async () => {
    const reads = new Set<string>()
    const existenceProbes = new Set<string>()
    const configured = ConfiguredProject.make(Path.join(fixtureRoot, "tsconfig.json"))

    const diagnostics = await Effect.runPromise(Workspace.use((workspace) => workspace.withSnapshot(
      {},
      Effect.gen(function*() {
        const snapshot = yield* WorkspaceSnapshot
        const project = yield* snapshot.project(configured)
        return yield* project.semanticDiagnosticCount()
      }),
    )).pipe(Effect.provide(layer({ projects: [configured] }, {
      cwd: fixtureRoot,
      fs: {
        readFile: (fileName) => {
          reads.add(fileName)
          return undefined
        },
        fileExists: (fileName) => {
          existenceProbes.add(fileName)
          return undefined
        },
      },
    }))))

    expect(diagnostics).toBeGreaterThan(0)
    expect([...reads].some((fileName) => fileName.endsWith("/tsconfig.json"))).toBe(true)
    expect([...reads].some((fileName) => fileName.endsWith("/src/symbol.ts"))).toBe(true)
    expect(existenceProbes.size).toBeGreaterThan(0)
  })
})
