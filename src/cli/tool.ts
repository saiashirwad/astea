/**
 * Agent Tool Protocol — bridge recipes into LLM-callable tools.
 *
 * Turns any `Recipe` into a typed, validated agent tool conforming
 * to standard LLM function-calling protocols (OpenAI / MCP / Anthropic).
 */
import { Data, Effect, Layer, Schema } from "effect"
import * as JSONSchema from "effect/JSONSchema"
import {
  Application,
  planApplicationLayerNode,
  Preview,
  Recipe,
  Verification,
  Workspace,
  type WorkspaceSnapshot,
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

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | ReadonlyArray<JsonValue> | JsonObject
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export type JsonSchemaDoc = JsonObject

export interface AgentTool<R = never> {
  readonly name: string
  readonly description: string
  readonly schema: JsonSchemaDoc
  readonly execute: (
    input: JsonValue,
    options?: { readonly apply?: boolean },
  ) => Effect.Effect<AgentToolResult, ToolExecutionError, Workspace | R>
}

export class ToolExecutionError extends Data.TaggedError("ToolExecutionError")<{
  readonly recipe: string
  readonly cause: unknown
}> {}

const emptyObjectSchema: JsonSchemaDoc = { type: "object", properties: {} }

/** Convert a recipe into a structured Agent Tool. */
export const recipeToAgentTool = <Input = undefined, E = never, R = never>(
  recipe: Recipe<Input, E, R>,
  description = `Transform codebase using ${recipe.name}`,
): AgentTool<Exclude<R, WorkspaceSnapshot>> => {
  let jsonSchema: JsonSchemaDoc = emptyObjectSchema
  if (recipe.schema !== undefined) {
    // SAFETY: JSONSchema generator yields a JSON-object document for object schemas
    const generated = JSONSchema.fromSchemaDraft2020_12(recipe.schema as never)
    const jsonDocument: unknown = generated
    // SAFETY: draft generator returns a JSON object document.
    jsonSchema = jsonDocument as JsonSchemaDoc
  }

  return {
    name: `teamod_${recipe.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    description,
    schema: jsonSchema,
    execute: (rawInput, options = {}) =>
      Effect.gen(function*() {
        const workspace = yield* Workspace
        const mainLayer = planApplicationLayerNode.pipe(Layer.provideMerge(Layer.succeed(Workspace, workspace)))

        const typedInput = yield* decodeToolInput(recipe, rawInput)
        const plan = yield* Recipe.run(recipe, typedInput).pipe(
          Effect.mapError((cause) => new ToolExecutionError({ recipe: recipe.name, cause })),
        )
        const preview = yield* Preview.of(plan).pipe(
          Effect.mapError((cause) => new ToolExecutionError({ recipe: recipe.name, cause })),
        )
        const verified = yield* Verification.verify(plan, recipe, typedInput).pipe(
          Effect.mapError((cause) => new ToolExecutionError({ recipe: recipe.name, cause })),
        )

        if (options.apply === true) {
          yield* Application.apply(verified).pipe(
            Effect.provide(mainLayer),
            Effect.mapError((cause) => new ToolExecutionError({ recipe: recipe.name, cause })),
          )
        }

        const files: ReadonlyArray<ToolFileResult> = preview.files.map((f: (typeof preview.files)[number]) => {
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

const decodeToolInput = <Input, E, R>(
  recipe: Recipe<Input, E, R>,
  rawInput: JsonValue,
): Effect.Effect<Input, ToolExecutionError> => {
  if (recipe.schema === undefined) {
    // SAFETY: recipes without schemas accept the caller-provided input contract
    return Effect.succeed(rawInput as Input)
  }
  // SAFETY: recipe schemas are pure and fail only with SchemaError.
  const decode = Schema.decodeUnknownEffect(recipe.schema) as (value: JsonValue) => Effect.Effect<Input, Schema.SchemaError, never>
  return decode(rawInput).pipe(
    Effect.mapError((cause) => new ToolExecutionError({ recipe: recipe.name, cause })),
  )
}
