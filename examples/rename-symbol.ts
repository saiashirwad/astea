import { ConfiguredProject, Draft, Policy, Recipe, WorkspaceSnapshot } from "safemods"
import { Effect } from "effect"

const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })

/**
 * Renames a declaration and every semantic reference to it, including imports
 * and aliases. Run it against fixtures/stress to preview the cross-file diff.
 */
export default Recipe.define("rename-old-name", {
  version: "1.0.0",
  policies: [Policy.matches({ min: 4 }), Policy.noNewErrors(), Policy.idempotent()],
  run: () =>
    Effect.gen(function*() {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(app)
      const oldName = yield* project.symbolNamed("oldName", { within: "src/symbol.ts" })
      return yield* Draft.renameSymbol(project, oldName, "increment")
    }),
})
