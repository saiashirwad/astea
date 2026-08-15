import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeSymbolResolver, symbolAtPositionRequest } from "./semantic-request.ts"
import { ConfiguredProject, layer, Workspace, WorkspaceSnapshot } from "./workspace-snapshot.ts"

const fixtureRoot = fileURLToPath(new URL("../../fixtures/query/", import.meta.url))
const libraryFileName = Path.join(fixtureRoot, "src/library.ts")

describe("Effect Request batching prototype", () => {
  it("coalesces independently composed lookups into one native array request", async () => {
    const configured = ConfiguredProject.make(Path.join(fixtureRoot, "tsconfig.json"))
    const batchSizes: Array<number> = []
    const result = await Effect.runPromise(Workspace.use((workspace) => workspace.withSnapshot(
      {},
      Effect.gen(function*() {
        const snapshot = yield* WorkspaceSnapshot
        const project = yield* snapshot.project(configured)
        const resolver = makeSymbolResolver(project, (size) => batchSizes.push(size))
        return yield* Effect.all([
          symbolAtPositionRequest(resolver, libraryFileName, "export function ".length),
          symbolAtPositionRequest(resolver, libraryFileName, "export function ".length),
          symbolAtPositionRequest(resolver, libraryFileName, "export function target".length + 50),
        ], { concurrency: "unbounded" })
      }),
    )).pipe(Effect.provide(layer({ projects: [configured] }, { cwd: fixtureRoot }))))

    expect(batchSizes).toEqual([3])
    expect(result[0]).toBe(result[1])
    expect(result[0]?.name).toBe("target")
  })
})
