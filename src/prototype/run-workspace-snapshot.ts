import { Effect } from "effect"
import { makeLifecycleFixture } from "./native-lifecycle.ts"
import { ConfiguredProject, layer, Workspace, WorkspaceSnapshot } from "./workspace-snapshot.ts"

const report = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const fixture = yield* makeLifecycleFixture
  const configured = ConfiguredProject.make(fixture.configFileName)

  return yield* Workspace.use((workspace) => workspace.withSnapshot({}, Effect.gen(function*() {
    const snapshot = yield* WorkspaceSnapshot
    const project = yield* snapshot.project(configured)
    return {
      generation: snapshot.generation,
      configuredProjects: snapshot.projects.map((project) => project.configFileName),
      sourceFileCount: (yield* project.sourceFileNames()).length,
      semanticDiagnosticCount: yield* project.semanticDiagnosticCount(),
    }
  }))).pipe(Effect.provide(layer(
    { projects: [configured] },
    { cwd: fixture.root, fs: fixture.overlay },
  )))
})))

console.log(report)
