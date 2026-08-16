/**
 * teatime CLI — Interactive command-line runner and inspection tool.
 */
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Effect, Layer } from "effect"
import {
  Application,
  ConfiguredProject,
  planApplicationLayerNode,
  Preview,
  Recipe,
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

export const runCli = (options: CliOptions): Effect.Effect<void, unknown, any> =>
  Effect.gen(function*() {
    const cwd = options.cwd ?? process.cwd()
    const resolvedRecipe = Path.resolve(cwd, options.recipePath)

    // Dynamic import recipe
    const imported = yield* Effect.tryPromise(() => import(resolvedRecipe))
    const recipe = (imported.default ?? imported.recipe ?? Object.values(imported).find((v: any) => v && typeof v === "object" && "run" in v && "version" in v)) as Recipe<any, any, any>

    if (recipe === undefined) {
      console.error(`Error: Could not find a exported Recipe in ${resolvedRecipe}`)
      process.exit(1)
    }

    if (options.toolSchema) {
      const tool = recipeToAgentTool(recipe)
      console.log(JSON.stringify(tool, null, 2))
      return
    }

    const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
    const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd })
    const mainLayer = planApplicationLayerNode.pipe(Layer.provideMerge(workspaceLayer))

    const useColor = options.noColor !== true && process.env.NO_COLOR === undefined

    yield* Effect.gen(function*() {
      const plan = yield* Recipe.run(recipe, options.input)
      const preview = yield* Preview.of(plan)

      console.log(renderPlanPreview(preview, { color: useColor }))

      if (options.mode === "verify" || options.mode === "apply") {
        const verified = yield* Verification.verify(plan, recipe, options.input)
        if (verified.diagnosticDiff) {
          console.log(renderDiagnosticDiff(verified.diagnosticDiff, { color: useColor }))
        }

        if (options.mode === "apply") {
          const receipt = yield* Application.apply(verified).pipe(Effect.provide(mainLayer))
          console.log(`\n✔ Applied ${receipt.outputs.length} file changes successfully!`)
        }
      }
    }).pipe(Effect.provide(workspaceLayer))
  })
