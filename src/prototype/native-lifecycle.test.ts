import { Effect, Exit } from "effect"
import type { Snapshot } from "typescript/unstable/async"
import { describe, expect, it } from "vitest"
import { layer, NativeCompiler } from "./native-compiler.ts"
import { inspectNativeLifecycle, makeLifecycleFixture } from "./native-lifecycle.ts"

describe("native TypeScript lifecycle prototype", () => {
  it("observes scoped snapshots, identity, batching, printing, and virtual updates", async () => {
    const report = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const fixture = yield* makeLifecycleFixture
      return yield* inspectNativeLifecycle(fixture).pipe(Effect.provide(layer({
        cwd: fixture.root,
        fs: fixture.overlay,
        collectTiming: true,
      })))
    })))

    expect(report.snapshotsHaveDistinctIds).toBe(true)
    expect(report.firstSnapshotStillQueryableAfterUpdate).toBe(true)
    expect(report.oldSemanticDiagnosticCount).toBe(0)
    expect(report.newSemanticDiagnosticCount).toBe(1)
    expect(report.changedSourceNodeWasReplaced).toBe(true)
    expect(report.unchangedSourceNodeWasRetained).toBe(true)
    expect(report.repeatedSymbolIdentityWithinSnapshot).toBe(true)
    expect(report.batchedSymbolIdentityWithinSnapshot).toBe(true)
    expect(report.symbolIdentityChangesAcrossSnapshots).toBe(true)
    expect(report.repeatedTypeIdentityWithinSnapshot).toBe(true)
    expect(report.typeIdentityChangesAcrossSnapshots).toBe(true)
    expect(report.batchedLookupRequestCount).toBeLessThan(report.singleLookupRequestCount)
    expect(report.synthesizedFragment).toContain("export const answer = 43")
    expect(report.diskRemainedUnchanged).toBe(true)
    expect(report.disposedSnapshotRejectsAccess).toBe(true)
    expect(report.disposedProgramRejectsRemoteQuery).toBe(true)
    expect(report.decodedSourceTextSurvivesDisposal).toBe(true)
    expect(report.emitterCanPrintDecodedNodeAfterDisposal).toBe(true)
    expect(report.sourceFilesFetchedSinceLastTimingReset).toBe(1)
    expect(report.nodesFetchedSinceLastTimingReset).toBeGreaterThan(0)
    expect(report.nodesMaterializedSinceLastTimingReset).toBeGreaterThan(0)
  })

  it("disposes an acquired snapshot when its Effect scope fails", async () => {
    let acquiredSnapshot: Snapshot | undefined

    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
      const fixture = yield* makeLifecycleFixture
      return yield* NativeCompiler.use((compiler) => Effect.scoped(Effect.gen(function*() {
        acquiredSnapshot = yield* compiler.openSnapshot({ openProjects: [fixture.configFileName] })
        return yield* Effect.fail("intentional prototype failure")
      }))).pipe(Effect.provide(layer({ cwd: fixture.root })))
    })))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(acquiredSnapshot?.isDisposed()).toBe(true)
  })
})
