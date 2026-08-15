import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  anchorSelection,
  anchorSymbol,
  resolveNodeAnchor,
  resolveSymbolAnchor,
} from "./identity.ts"
import { calls, collect, resolvesToSymbol, symbolAtPosition, whereBatched } from "./semantic-query.ts"
import { ConfiguredProject, layer, Workspace, WorkspaceSnapshot } from "./workspace-snapshot.ts"

const fixtureSource = fileURLToPath(new URL("../../fixtures/query/", import.meta.url))

describe("snapshot-bound identity prototype", () => {
  it("re-resolves exact evidence and rejects a shifted durable locator", async () => {
    const fixtureRoot = await Fs.mkdtemp(Path.join(Os.tmpdir(), "teatime-identity-"))
    await Fs.cp(fixtureSource, fixtureRoot, { recursive: true })
    const configFileName = Path.join(fixtureRoot, "tsconfig.json")
    const libraryFileName = Path.join(fixtureRoot, "src/library.ts")
    const configured = ConfiguredProject.make(configFileName)

    try {
      const result = await Effect.runPromise(Workspace.use((workspace) => Effect.gen(function*() {
        const first = yield* workspace.withSnapshot({}, Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          const project = yield* snapshot.project(configured)
          const target = yield* symbolAtPosition(project, libraryFileName, "export function ".length)
          if (target === undefined) return yield* Effect.die("Target symbol missing")
          const selections = yield* calls(project).pipe(
            whereBatched(resolvesToSymbol(project, target)),
            collect,
          )
          const anchored = {
            node: yield* anchorSelection(project, selections[0]!),
            symbol: yield* anchorSymbol(project, target),
          }
          const shiftedFailure = yield* resolveNodeAnchor(project, {
            ...anchored.node,
            start: anchored.node.start + 1,
          }).pipe(Effect.match({
            onFailure: (error) => error._tag,
            onSuccess: () => "unexpected-success",
          }))
          return {
            anchored,
            unchanged: {
              nodeText: (yield* resolveNodeAnchor(project, anchored.node)).getText(),
              symbolName: (yield* resolveSymbolAnchor(project, anchored.symbol)).name,
            },
            shiftedFailure,
          }
        }))
        return first
      })).pipe(Effect.provide(layer(
        { projects: [configured] },
        { cwd: fixtureRoot },
      ))))

      expect(result.unchanged).toEqual({ nodeText: "renamed(1)", symbolName: "target" })
      expect(result.shiftedFailure).toBe("AnchorMismatch")
      expect(result.anchored.node.fileName).toBe("src/consumer.ts")
      expect(result.anchored.symbol.declarations[0]?.fileName).toBe("src/library.ts")
    } finally {
      await Fs.rm(fixtureRoot, { recursive: true, force: true })
    }
  })
})
