import { Effect, Schema } from "effect"
import * as Draft from "safemods/Draft"
import * as Policy from "safemods/Policy"
import * as Query from "safemods/Query"
import * as Recipe from "safemods/Recipe"
import { recipeToAgentTool } from "safemods/AgentTool"
import { ConfiguredProject, WorkspaceSnapshot } from "safemods/Workspace"

const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })

export const InputSchema = Schema.Struct({
  oldName: Schema.NonEmptyString,
  newName: Schema.NonEmptyString,
  fileName: Schema.NonEmptyString,
})

type Input = typeof InputSchema.Type

export const renameRecipe = Recipe.define("rename-selected-symbol", {
  version: "1.0.0",
  schema: InputSchema,
  policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
  run: (input: Input) =>
    Effect.gen(function* () {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(app)
      const symbol = yield* project.symbolNamed(input.oldName, { within: input.fileName })
      const references = yield* Query.referencesTo(project, symbol).pipe(
        Query.within(input.fileName),
        Query.collect,
      )
      return yield* Draft.replaceEach(references, () => input.newName)
    }),
})

export const renameTool = recipeToAgentTool(
  renameRecipe,
  "Rename a selected symbol and return a verified structured result.",
)
