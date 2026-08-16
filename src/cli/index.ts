/**
 * safemods CLI — Interactive command-line runner and inspection tool.
 */
import { path as Path } from "../platform/node.ts"
import { Config, Console, Data, Effect, Layer, Option, Predicate, Schema } from "effect"
import {
  Application,
  ConfiguredProject,
  planApplicationLayerNode,
  Preview,
  type Recipe,
  Recipe as RecipeApi,
  Verification,
  Workspace,
} from "../api/index.ts"
import { renderDiagnosticDiff, renderPlanPreview } from "./diff.ts"
import { recipeToAgentTool } from "./tool.ts"

export interface CliOptions {
  readonly recipePath: string
  readonly input?: unknown
  readonly cwd?: string
  readonly mode?: "preview" | "verify" | "apply"
  readonly toolSchema?: boolean
  readonly noColor?: boolean
}

export class CliError extends Data.TaggedError("CliError")<{
  readonly message: string
}> {}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This type guard is the dynamic module-import boundary.
const isRecipe = (value: unknown): value is Recipe<unknown> => {
  if (value === null || !Predicate.isObject(value)) return false
  return "run" in value && "version" in value && "name" in value
}

const loadRecipe = (resolvedRecipe: string): Effect.Effect<Recipe<unknown>, CliError> =>
  Effect.tryPromise({
    try: () => import(resolvedRecipe),
    catch: (cause) => new CliError({ message: `Failed to import recipe module: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((imported) => {
      if (!Predicate.isObject(imported)) {
        return Effect.fail(new CliError({ message: `Recipe module is not an object: ${resolvedRecipe}` }))
      }
      if ("default" in imported && isRecipe(imported.default)) {
        return Effect.succeed(imported.default)
      }
      if ("recipe" in imported && isRecipe(imported.recipe)) {
        return Effect.succeed(imported.recipe)
      }
      for (const value of Object.values(imported)) {
        if (isRecipe(value)) return Effect.succeed(value)
      }
      return Effect.fail(new CliError({ message: `Could not find an exported Recipe in ${resolvedRecipe}` }))
    }),
  )

const JsonText = Schema.fromJsonString(Schema.Unknown)

export const runCli = (options: CliOptions): Effect.Effect<void, CliError> =>
  Effect.gen(function*() {
    const targetCwd = options.cwd !== undefined
      ? Path.resolve(process.cwd(), options.cwd)
      : process.cwd()
    const resolvedRecipe = Path.resolve(process.cwd(), options.recipePath)

    const recipe = yield* loadRecipe(resolvedRecipe)

    if (options.toolSchema === true) {
      const tool = recipeToAgentTool(recipe)
      const encoded = yield* Schema.encodeEffect(JsonText)(tool).pipe(
        Effect.mapError((cause) => new CliError({ message: String(cause) })),
      )
      yield* Console.log(encoded)
      return
    }

    const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
    const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: targetCwd })
    const mainLayer = planApplicationLayerNode.pipe(Layer.provideMerge(workspaceLayer))

    const noColorConfig = yield* Config.string("NO_COLOR").pipe(
      Config.option,
      Effect.orDie,
    )
    const useColor = options.noColor !== true && Option.isNone(noColorConfig)

    yield* Effect.gen(function*() {
      const plan = yield* RecipeApi.run(recipe, options.input)
      const preview = yield* Preview.of(plan)

      yield* Console.log(renderPlanPreview(preview, { color: useColor }))

      if (options.mode === "verify" || options.mode === "apply") {
        const verified = yield* Verification.verify(plan, recipe, options.input)
        if (verified.diagnosticDiff) {
          yield* Console.log(renderDiagnosticDiff(verified.diagnosticDiff, { color: useColor }))
        }

        if (options.mode === "apply") {
          const receipt = yield* Application.apply(verified).pipe(Effect.provide(mainLayer))
          yield* Console.log(`\n✔ Applied ${receipt.outputs.length} file changes successfully!`)
        }
      }
    }).pipe(
      Effect.provide(workspaceLayer),
      Effect.mapError((cause) => new CliError({ message: String(cause) })),
    )
  })
