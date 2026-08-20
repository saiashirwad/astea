import { nodeFsPromises as Fs } from "../platform/node.ts"
import { fileURLToPath } from "node:url"
import { Effect, Layer, type FileSystem, type Path } from "effect"
import { layer as nodeLayer, workspaceLayerNode } from "../Node/index.ts"
import { ConfiguredProject, type Workspace, type WorkspaceRuntime } from "../Workspace/index.ts"

const fixtureSource = fileURLToPath(new URL("../../fixtures/recipe/", import.meta.url))

export const withFixture = <A, E, R>(
  use: (root: string, app: ConfiguredProject) => Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  unknown,
  Exclude<R, Workspace | WorkspaceRuntime | FileSystem.FileSystem | Path.Path>
> =>
  Effect.acquireUseRelease(
    Effect.tryPromise(async () => {
      const root = await Fs.mkdtemp("/tmp/safemods-decl-")
      await Fs.cp(fixtureSource, root, { recursive: true })
      return root
    }),
    (root) => {
      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
      const workspaceLayer = workspaceLayerNode({ projects: [app] }, { cwd: root })
      const runtimeLayer = Layer.merge(workspaceLayer, nodeLayer)
      return use(root, app).pipe(Effect.provide(runtimeLayer))
    },
    (root) =>
      Effect.tryPromise(() => Fs.rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
  )
