/**
 * Agent Tool Protocol — bridge recipes into LLM-callable tools.
 *
 * Turns any `Recipe` into a typed, validated agent tool conforming
 * to standard LLM function-calling protocols (OpenAI / MCP / Anthropic).
 */
import { Effect, Layer } from "effect"
import * as JSONSchema from "effect/JSONSchema"
import {
  Application,
  planApplicationLayerNode,
  Preview,
  Recipe,
  Verification,
  Workspace,
} from "../api/index.ts"

export type ToolAction = "create" | "delete" | "modify"

export interface ToolFileResult {
  readonly fileName: string
  readonly action: ToolAction
}

export interface AgentToolResult {
  readonly planId: string
  readonly status: "preview" | "applied"
  readonly affectedFiles: number
  readonly diagnosticDelta: number
  readonly idempotenceChecked: boolean
  readonly files: ReadonlyArray<ToolFileResult>
}

export interface AgentTool {
  readonly name: string
  readonly description: string
  readonly schema: JsonSchemaDoc
  readonly execute: (
    input: JsonPayload,
    options?: { readonly apply?: boolean },
  ) => Effect.Effect<AgentToolResult, unknown, any>
}

export type JsonPayload = null | boolean | number | string | ReadonlyArray<any> | { readonly [key: string]: any }
export type JsonSchemaDoc = { readonly [key: string]: any }

/** Convert a recipe into a structured Agent Tool. */
export const recipeToAgentTool = <Input = undefined, E = never, R = never>(
  recipe: Recipe<Input, E, R>,
  description = `Transform codebase using ${recipe.name}`,
): AgentTool => {
  // SAFETY: JSONSchema generation produces valid document structure
  const jsonSchema: JsonSchemaDoc = recipe.schema !== undefined
    // SAFETY: Effect Schema AST is compatible with JSONSchema generator
    ? (JSONSchema.fromSchemaDraft2020_12(recipe.schema as never) as unknown as JsonSchemaDoc)
    : { type: "object", properties: {} }

  return {
    name: `teatime_${recipe.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    description,
    schema: jsonSchema,
    execute: (rawInput: JsonPayload, options = {}) =>
      Effect.gen(function*() {
        const workspace = yield* Workspace
        const mainLayer = planApplicationLayerNode.pipe(Layer.provideMerge(Layer.succeed(Workspace, workspace)))

        // SAFETY: Recipe.run internally validates input against recipe.schema
        const typedInput = rawInput as Input
        const plan = yield* Recipe.run(recipe, typedInput)
        const preview = yield* Preview.of(plan)
        const verified = yield* Verification.verify(plan, recipe, typedInput)

        if (options.apply === true) {
          yield* Application.apply(verified).pipe(Effect.provide(mainLayer))
        }

        const files: ReadonlyArray<ToolFileResult> = preview.files.map((f) => {
          const action: ToolAction = f.beforeText === "" ? "create" : f.afterText === "" ? "delete" : "modify"
          return { fileName: f.fileName, action }
        })

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
