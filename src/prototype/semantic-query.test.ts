import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  calls,
  collect,
  referencesInProject,
  resolvesToSymbol,
  symbolAtPosition,
  whereBatched,
} from "./semantic-query.ts"
import { ConfiguredProject, layer, Workspace, WorkspaceSnapshot } from "./workspace-snapshot.ts"

const fixtureRoot = fileURLToPath(new URL("../../fixtures/query/", import.meta.url))
const configFileName = Path.join(fixtureRoot, "tsconfig.json")
const libraryFileName = Path.join(fixtureRoot, "src/library.ts")

describe("semantic query prototype", () => {
  it("selects calls by canonical symbol across aliases and re-exports", async () => {
    const configured = ConfiguredProject.make(configFileName)
    const report = await Effect.runPromise(Workspace.use((workspace) => workspace.withSnapshot(
      {},
      Effect.gen(function*() {
        const snapshot = yield* WorkspaceSnapshot
        const project = yield* snapshot.project(configured)
        const target = yield* symbolAtPosition(project, libraryFileName, "export function ".length)
        if (target === undefined) return yield* Effect.die("Target symbol was not found")

        const selections = yield* calls(project).pipe(
          whereBatched(resolvesToSymbol(project, target)),
          collect,
        )
        const references = yield* referencesInProject(project, target)

        return {
          texts: selections.map((selection) => selection.value.getText()),
          evidence: selections.map((selection) => selection.evidence),
          referenceCount: references.length,
        }
      }),
    )).pipe(Effect.provide(layer(
      { projects: [configured] },
      { cwd: fixtureRoot },
    ))))

    expect(report.texts).toEqual(["renamed(1)", "publicTarget(4)"])
    expect(report.evidence.every((evidence) =>
      evidence.some((item) => item.criterion === "resolves-to-symbol"))).toBe(true)
    expect(report.referenceCount).toBeGreaterThanOrEqual(2)
  })
})
