/**
 * AgentTool domain — bridge recipes into LLM-callable tools.
 *
 * Turns any `Recipe` into a typed, validated agent tool conforming
 * to standard LLM function-calling protocols (OpenAI / MCP / Anthropic).
 */
import { Data, Effect, Layer, Predicate, Schema, SchemaIssue } from "effect"
import { apply } from "../Application/index.ts"
import { applicationLayerNode } from "../Node/index.ts"
import { type Recipe as RecipeModel, RecipeInputError, run as runRecipe } from "../Recipe/index.ts"
import {
  of as previewOf,
  StalePlanError,
  VerificationFailure,
  verify,
  type PolicyResult,
} from "../Verification/index.ts"
import type { DiagnosticDiff, DiagnosticRecord } from "../Policy/index.ts"
import { Workspace, type WorkspaceSnapshot } from "../Workspace/index.ts"

export type ToolAction = "create" | "delete" | "modify" | "move"

export interface ToolFileResult {
  readonly fileName: string
  readonly action: ToolAction
}

/** A compiler diagnostic in the JSON response format used by agent tools. */
export type ToolDiagnostic = DiagnosticRecord

export interface ToolDiagnosticReport {
  readonly introduced: ReadonlyArray<ToolDiagnostic>
  readonly resolved: ReadonlyArray<ToolDiagnostic>
  readonly unchanged: ReadonlyArray<ToolDiagnostic>
}

export interface ToolPolicyResult {
  readonly name: string
  readonly passed: boolean
  readonly detail?: string | undefined
}

export interface ToolSchemaIssue {
  readonly path: ReadonlyArray<string | number>
  readonly code: string
  readonly message: string
}

export type ToolExecutionErrorDetails =
  | {
      readonly _tag: "VerificationFailure"
      readonly policy: VerificationFailure["policy"]
      readonly detail: string
      readonly diagnostics: ReadonlyArray<ToolDiagnostic>
    }
  | {
      readonly _tag: "StalePlanError"
      readonly planId: string
      readonly projectId: string
      readonly fileName: string
    }
  | {
      readonly _tag: "SchemaError"
      readonly issues: ReadonlyArray<ToolSchemaIssue>
    }
  | {
      readonly _tag: "UnknownToolError"
      readonly message: string
    }

export interface AgentToolResult {
  readonly planId: string
  readonly status: "preview" | "applied"
  readonly affectedFiles: number
  readonly diagnosticDelta: number
  readonly idempotenceChecked: boolean
  readonly files: ReadonlyArray<ToolFileResult>
  readonly diagnostics: ToolDiagnosticReport
  readonly policyResults: ReadonlyArray<ToolPolicyResult>
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
  readonly details: ToolExecutionErrorDetails
}> {}

const emptyObjectSchema: JsonSchemaDoc = { type: "object", properties: {} }

/** Convert a recipe into a structured Agent Tool. */
export const recipeToAgentTool = <Input = undefined, E = never, R = never>(
  recipe: RecipeModel<Input, E, R>,
  description = `Transform codebase using ${recipe.name}`,
): AgentTool<Exclude<R, WorkspaceSnapshot>> => {
  let jsonSchema: JsonSchemaDoc = emptyObjectSchema
  if (recipe.schema !== undefined) {
    // SAFETY: JSONSchema generator yields a JSON-object document for object schemas
    const generated = Schema.toJsonSchemaDocument(recipe.schema)
    const jsonDocument: unknown = generated
    // SAFETY: draft generator returns a JSON object document.
    jsonSchema = jsonDocument as JsonSchemaDoc
  }

  return {
    name: `safemods_${recipe.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    description,
    schema: jsonSchema,
    execute: (rawInput, options = {}) =>
      Effect.gen(function* () {
        const workspace = yield* Workspace
        const mainLayer = applicationLayerNode.pipe(
          Layer.provideMerge(Layer.succeed(Workspace, workspace)),
        )

        const typedInput = yield* decodeToolInput(recipe, rawInput)
        const plan = yield* runRecipe(recipe, typedInput).pipe(
          Effect.mapError((cause) => makeToolExecutionError(recipe.name, cause)),
        )
        const preview = yield* previewOf(plan).pipe(
          Effect.mapError((cause) => makeToolExecutionError(recipe.name, cause)),
        )
        const verified = yield* verify(plan, recipe, typedInput).pipe(
          Effect.mapError((cause) => makeToolExecutionError(recipe.name, cause)),
        )

        if (options.apply === true) {
          yield* apply(verified).pipe(
            Effect.provide(mainLayer),
            Effect.mapError((cause) => makeToolExecutionError(recipe.name, cause)),
          )
        }

        const files: ReadonlyArray<ToolFileResult> = preview.files.map((file) => ({
          fileName: file.fileName,
          action: file.action,
        }))

        return {
          planId: plan.planId,
          status: options.apply === true ? ("applied" as const) : ("preview" as const),
          affectedFiles: preview.files.length,
          diagnosticDelta: verified.receipt.diagnosticDelta,
          idempotenceChecked: verified.receipt.idempotenceChecked,
          files,
          diagnostics: toDiagnosticReport(verified.diagnosticDiff),
          policyResults: verified.receipt.policyResults.map(toToolPolicyResult),
        }
      }),
  }
}

const decodeToolInput = <Input, E, R>(
  recipe: RecipeModel<Input, E, R>,
  rawInput: JsonValue,
): Effect.Effect<Input, ToolExecutionError> => {
  if (recipe.schema === undefined) {
    // SAFETY: recipes without schemas accept the caller-provided input contract
    return Effect.succeed(rawInput as Input)
  }
  // SAFETY: recipe schemas are pure and fail only with SchemaError.
  const decode = Schema.decodeUnknownEffect(recipe.schema) as (
    value: JsonValue,
  ) => Effect.Effect<Input, Schema.SchemaError>
  return decode(rawInput).pipe(
    Effect.mapError((cause) => makeToolExecutionError(recipe.name, cause)),
  )
}

const toToolPolicyResult = (result: PolicyResult): ToolPolicyResult => ({
  name: result.name,
  passed: result.passed,
  ...(result.detail === undefined ? {} : { detail: result.detail }),
})

const toToolDiagnostic = (diagnostic: DiagnosticRecord): ToolDiagnostic => ({
  code: diagnostic.code,
  message: diagnostic.message,
  category: diagnostic.category,
  ...(diagnostic.fileName === undefined ? {} : { fileName: diagnostic.fileName }),
  ...(diagnostic.start === undefined ? {} : { start: diagnostic.start }),
  ...(diagnostic.length === undefined ? {} : { length: diagnostic.length }),
})

const toDiagnosticReport = (diff: DiagnosticDiff): ToolDiagnosticReport => ({
  introduced: diff.introduced.map(toToolDiagnostic),
  resolved: diff.resolved.map(toToolDiagnostic),
  unchanged: diff.unchanged.map(toToolDiagnostic),
})

const schemaIssueFormatter = SchemaIssue.makeFormatterDefault()

const flattenSchemaIssue = (
  issue: SchemaIssue.Issue,
  prefix: ReadonlyArray<string | number> = [],
): ReadonlyArray<ToolSchemaIssue> => {
  switch (issue._tag) {
    case "Pointer":
      return flattenSchemaIssue(
        issue.issue,
        prefix.concat(
          issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
        ),
      )
    case "Composite":
      return issue.issues.flatMap((child) => flattenSchemaIssue(child, prefix))
    case "Filter":
    case "Encoding":
      return flattenSchemaIssue(issue.issue, prefix)
    case "AnyOf":
    case "Forbidden":
    case "InvalidType":
    case "InvalidValue":
    case "MissingKey":
    case "OneOf":
    case "UnexpectedKey":
      return [
        {
          path: prefix,
          code: issue._tag,
          message: schemaIssueFormatter(issue),
        },
      ]
  }
}

const schemaDetails = (cause: Schema.SchemaError): ToolExecutionErrorDetails => ({
  _tag: "SchemaError",
  issues: flattenSchemaIssue(cause.issue),
})

const nestedCause = (cause: unknown): unknown =>
  Predicate.isObject(cause) && "cause" in cause ? cause.cause : undefined

const detailsForCause = (cause: unknown): ToolExecutionErrorDetails => {
  if (cause instanceof VerificationFailure) {
    return {
      _tag: "VerificationFailure",
      policy: cause.policy,
      detail: cause.detail,
      diagnostics: (cause.diagnostics ?? []).map(toToolDiagnostic),
    }
  }
  if (cause instanceof StalePlanError) {
    return {
      _tag: "StalePlanError",
      planId: cause.planId,
      projectId: cause.projectId,
      fileName: cause.fileName,
    }
  }
  if (Schema.isSchemaError(cause)) return schemaDetails(cause)
  if (cause instanceof RecipeInputError && Schema.isSchemaError(cause.cause)) {
    return schemaDetails(cause.cause)
  }
  const nested = nestedCause(cause)
  if (nested !== undefined && Schema.isSchemaError(nested)) return schemaDetails(nested)
  return { _tag: "UnknownToolError", message: String(cause) }
}

const makeToolExecutionError = (recipe: string, cause: unknown): ToolExecutionError =>
  new ToolExecutionError({ recipe, cause, details: detailsForCause(cause) })
