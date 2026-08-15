import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Deferred, Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeLifecycleFixture } from "./native-lifecycle.ts"
import {
  ConfiguredProject,
  layer,
  SnapshotExpired,
  Workspace,
  WorkspaceSnapshot,
  type ProjectSnapshot,
} from "./workspace-snapshot.ts"

const multiRoot = fileURLToPath(new URL("../../fixtures/multi/", import.meta.url))

describe("workspace and snapshot domain prototype", () => {
  it("provides one configured project through a region-scoped snapshot capability", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const fixture = yield* makeLifecycleFixture
      const configured = ConfiguredProject.make(fixture.configFileName)

      return yield* Workspace.use((workspace) => Effect.gen(function*() {
        let escapedProject: ProjectSnapshot | undefined
        const observed = yield* workspace.withSnapshot({}, Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          const project = yield* snapshot.project(configured)
          escapedProject = project
          return {
            generation: snapshot.generation,
            projectCount: snapshot.projects.length,
            sourceFileNames: yield* project.sourceFileNames(),
            semanticDiagnosticCount: yield* project.semanticDiagnosticCount(),
          }
        }))

        const escapedError = yield* escapedProject!.sourceFileNames().pipe(
          Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
        )

        return { observed, escapedError }
      })).pipe(Effect.provide(layer(
        { projects: [configured] },
        { cwd: fixture.root, fs: fixture.overlay },
      )))
    })))

    expect(result.observed.generation).toBe(1)
    expect(result.observed.projectCount).toBe(1)
    expect(result.observed.sourceFileNames.some((fileName) => fileName.endsWith("/src/index.ts"))).toBe(true)
    expect(result.observed.semanticDiagnosticCount).toBe(0)
    expect(result.escapedError).toBeInstanceOf(SnapshotExpired)
  })

  it("models a transition as a new immutable workspace generation", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const fixture = yield* makeLifecycleFixture
      const configured = ConfiguredProject.make(fixture.configFileName)

      return yield* Workspace.use((workspace) => Effect.gen(function*() {
        const first = yield* workspace.withSnapshot({}, Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          const project = yield* snapshot.project(configured)
          return {
            generation: snapshot.generation,
            diagnostics: yield* project.semanticDiagnosticCount(),
          }
        }))

        fixture.setOverlay(fixture.changedFileName, fixture.changedText)
        const second = yield* workspace.withSnapshot(
          { changes: { changed: [fixture.changedFileName] } },
          Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(configured)
            return {
              generation: snapshot.generation,
              diagnostics: yield* project.semanticDiagnosticCount(),
            }
          }),
        )

        return { first, second }
      })).pipe(Effect.provide(layer(
        { projects: [configured] },
        { cwd: fixture.root, fs: fixture.overlay },
      )))
    })))

    expect(result.first).toEqual({ generation: 1, diagnostics: 0 })
    expect(result.second).toEqual({ generation: 2, diagnostics: 1 })
  })

  it("serializes generation creation while allowing snapshot regions to overlap", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const fixture = yield* makeLifecycleFixture
      const configured = ConfiguredProject.make(fixture.configFileName)

      return yield* Workspace.use((workspace) => Effect.gen(function*() {
        const firstReady = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()

        const first = workspace.withSnapshot({}, Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          yield* Deferred.succeed(firstReady, undefined)
          yield* Deferred.await(releaseFirst)
          return snapshot.generation
        }))
        const second = Effect.andThen(
          Deferred.await(firstReady),
          workspace.withSnapshot({}, Effect.map(WorkspaceSnapshot, (snapshot) => snapshot.generation)),
        ).pipe(Effect.ensuring(Deferred.succeed(releaseFirst, undefined)))

        return yield* Effect.all([first, second], { concurrency: "unbounded" })
      })).pipe(Effect.provide(layer(
        { projects: [configured] },
        { cwd: fixture.root, fs: fixture.overlay },
      )))
    })))

    expect(result).toEqual([1, 2])
  })

  it("treats multiple configured projects as normal members of one generation", async () => {
    const projectA = ConfiguredProject.make(Path.join(multiRoot, "a/tsconfig.json"))
    const projectB = ConfiguredProject.make(Path.join(multiRoot, "b/tsconfig.json"))

    const result = await Effect.runPromise(Workspace.use((workspace) => workspace.withSnapshot(
      {},
      Effect.gen(function*() {
        const snapshot = yield* WorkspaceSnapshot
        const [a, b] = yield* Effect.all([
          snapshot.project(projectA),
          snapshot.project(projectB),
        ])
        return {
          projectCount: snapshot.projects.length,
          aFiles: yield* a.sourceFileNames(),
          bFiles: yield* b.sourceFileNames(),
          diagnostics: yield* Effect.all([
            a.semanticDiagnosticCount(),
            b.semanticDiagnosticCount(),
          ]),
        }
      }),
    )).pipe(Effect.provide(layer(
      { projects: [projectA, projectB] },
      { cwd: multiRoot },
    ))))

    expect(result.projectCount).toBe(2)
    expect(result.aFiles.some((fileName) => fileName.endsWith("/a/src/index.ts"))).toBe(true)
    expect(result.bFiles.some((fileName) => fileName.endsWith("/b/src/index.ts"))).toBe(true)
    expect(result.diagnostics).toEqual([0, 0])
  })
})
