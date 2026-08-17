import { Effect } from "effect"
import * as Draft from "safemods/Draft"
import * as Overlay from "safemods/Overlay"
import * as Policy from "safemods/Policy"
import * as Query from "safemods/Query"
import * as Recipe from "safemods/Recipe"
import { ConfiguredProject, WorkspaceSnapshot } from "safemods/Workspace"

const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })

export default Recipe.define("rename-config-import", {
  version: "1.0.0",
  policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
  run: Effect.fnUntraced(function* () {
    const snapshot = yield* WorkspaceSnapshot
    const project = yield* snapshot.project(app)
    const staged = yield* Draft.imports.addNamed(project, "src/library.ts", {
      module: "./types.js",
      name: "Config",
      alias: "RuntimeConfig",
    })

    const downstream = yield* Overlay.run(
      staged,
      Effect.gen(function* () {
        const overlaySnapshot = yield* WorkspaceSnapshot
        const overlayProject = yield* overlaySnapshot.project(app)
        const references = yield* Query.identifiers(overlayProject).pipe(
          Query.where(Query.textMatches("Config")),
          Query.within("src"),
          Query.collect,
        )
        return yield* Draft.replaceEach(references, ({ value }) => ({
          node: value,
          text: "RuntimeConfig",
        }))
      }),
    )

    return Draft.concat(staged, downstream)
  }),
})
