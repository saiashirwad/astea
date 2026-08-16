/**
 * Agent Tool Protocol — bridge recipes into LLM-callable tools.
 *
 * Turns any `Recipe` into a typed, validated agent tool conforming
 * to standard LLM function-calling protocols (OpenAI / MCP / Anthropic).
 */
import { Effect, Layer, Schema } from "effect"
import * as JSONSchema from "effect/JSONSchema"
import {
  Application,
  type ConfiguredProject,
  planApplicationLayerNode,
  Preview,
  Recipe,
  type RecipeDefinition,
  Verification,
  Workspace,
  WorkspaceSnapshot,
} from "../api/index.ts"

export interface AgentTool {
  readonly name: string
  readonly description: string
  readonly schema: Record<string, unknown>
  readonly execute: (
    input: unknown,
    options?: { readonly apply?: boolean },
  ) => Effect.Effect<
    {
      readonly planId: string
      readonly status: "preview" | "applied"
      readonly affectedFiles: number
      readonly diagnosticDelta: number
      readonly idempotenceChecked: boolean
      readonly files: ReadonlyArray<{ readonly fileName: string; readonly action: "create" | "delete" | "modify" }>
    },
    unknown,
    any
  >
}

/** Convert a recipe into a structured Agent Tool. */
export const recipeToAgentTool = <Input = undefined, E = never, R = never>(
  recipe: Recipe<Input, E, R>,
  description = `Transform codebase using ${recipe.name}`,
): AgentTool => {
  const jsonSchema = recipe.schema !== undefined
    ? ((JSONSchema.fromSchemaDraft2020_12(recipe.schema as any) as unknown) as Record<string, unknown>)
    : { type: "object", properties: {} }

  return {
    name: `teatime_${recipe.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    description,
    schema: jsonSchema,
    execute: (rawInput: unknown, options = {}) =>
      Effect.gen(function*() {
        const workspace = yield* Workspace
        const mainLayer = planApplicationLayerNode.pipe(Layer.provideMerge(Layer.succeed(Workspace, workspace)))

        const plan = yield* Recipe.run(recipe, rawInput as Input)
        const preview = yield* Preview.of(plan)
        const verified = yield* Verification.verify(plan, recipe, rawInput as Input)

        if (options.apply === true) {
          yield* Application.apply(verified).pipe(Effect.provide(mainLayer))
        }

        const files = preview.files.map((f) => ({
          fileName: f.fileName,
          action: (f.beforeText === "" ? "create" : f.afterText === "" ? "delete" : "modify") as "create" | "delete" | "modify",
        }))

        return {
          planId: plan.planId,
          status: options.apply === true ? ("applied" as const) : ("preview" as const),
          affectedFiles: preview.files.length,
          diagnosticDelta: verified.receipt.diagnosticDelta,
          idempotenceChecked: verified.receipt.idempotenceChecked,
          files,
        }
      }),
  }
}
