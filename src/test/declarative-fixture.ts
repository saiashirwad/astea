import { nodeFsPromises as Fs } from "../platform/node.ts"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { ConfiguredProject, Workspace } from "../Workspace/index.ts"

const fixtureSource = fileURLToPath(new URL("../../fixtures/recipe/", import.meta.url))

export const withFixture = <A, E, R>(
  use: (root: string, app: ConfiguredProject) => Effect.Effect<A, E, R>,
): Effect.Effect<A, unknown, Exclude<R, Workspace>> =>
  Effect.acquireUseRelease(
    Effect.tryPromise(async () => {
      const root = await Fs.mkdtemp("/tmp/safemods-decl-")
      await Fs.cp(fixtureSource, root, { recursive: true })
      return root
    }),
    (root) => {
      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
      const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })
      return use(root, app).pipe(Effect.provide(workspaceLayer))
    },
    (root) =>
      Effect.tryPromise(() => Fs.rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
  )
