/**
 * Safemods CLI — interactive runner and inspection tool.
 */
import { path as Path } from "../platform/node.ts"
import { Config, Console, Data, Effect, Layer, Match, Option, Predicate, Schema } from "effect"
import { EditConflict, InvalidEdit } from "../Edit/index.ts"
import { executeRecipe, type RecipeExecutionHooks } from "../Execution/index.ts"
import { applicationLayerNode, layer as nodeLayer, workspaceLayerNode } from "../Node/index.ts"
import { RecipeInputError, type Recipe } from "../Recipe/index.ts"
import { StalePlanError, VerificationFailure } from "../Verification/index.ts"
import {
  ConfiguredProject,
  FileNotFound,
  SymbolNotFound,
  Workspace,
  WorkspaceSnapshot,
} from "../Workspace/index.ts"
import {
  buildAuditReport,
  CliMatchFoundError,
  computeLineAndColumn,
  renderAuditCsv,
  renderAuditJson,
  renderAuditText,
  type AuditCriterionRecord,
  type AuditFinding,
  type AuditReport,
} from "./Audit.ts"
import { renderDiagnosticDiff, renderPlanPreview } from "./Diff.ts"
import { recipeToAgentTool } from "../AgentTool/FromRecipe.ts"

export type { AuditCriterionRecord, AuditFinding, AuditReport }
export {
  buildAuditReport,
  CliMatchFoundError,
  computeLineAndColumn,
  renderAuditCsv,
  renderAuditJson,
  renderAuditText,
}

export interface CliOptions {
  readonly recipePath: string
  readonly input?: unknown
  readonly cwd?: string | undefined
  readonly mode?: "preview" | "verify" | "apply" | "scan"
  readonly format?: "text" | "json" | "csv"
  readonly failOnMatch?: boolean
  readonly toolSchema?: boolean
  readonly noColor?: boolean
}

export class CliError extends Data.TaggedError("CliError")<{
  readonly message: string
}> {}

type CliTaggedError =
  | VerificationFailure
  | RecipeInputError
  | SymbolNotFound
  | FileNotFound
  | StalePlanError
  | EditConflict
  | InvalidEdit
  | CliError

const formatTaggedCliError = Match.typeTags<CliTaggedError, string>()({
  VerificationFailure: (error) =>
    `Verification Failed: Policy '${error.policy}' failed (${error.detail})`,
  RecipeInputError: (error) => `Invalid Recipe Input for '${error.recipe}': ${String(error.cause)}`,
  SymbolNotFound: (error) =>
    `Symbol Not Found: '${error.name}' was not found in '${error.fileName}'`,
  FileNotFound: (error) => `File Not Found: '${error.fileName}' in project '${error.projectId}'`,
  StalePlanError: (error) =>
    `Stale Plan: '${error.fileName}' in project '${error.projectId}' was modified after snapshot`,
  EditConflict: (error) => `Edit Conflict: Overlapping edits detected in '${error.left.fileName}'`,
  InvalidEdit: (error) => `Invalid Edit (${error.reason}) in '${error.edit.fileName}'`,
  CliError: (error) => error.message,
})

const isCliTaggedError = (cause: unknown): cause is CliTaggedError =>
  cause instanceof VerificationFailure ||
  cause instanceof RecipeInputError ||
  cause instanceof SymbolNotFound ||
  cause instanceof FileNotFound ||
  cause instanceof StalePlanError ||
  cause instanceof EditConflict ||
  cause instanceof InvalidEdit ||
  cause instanceof CliError

const formatCliError = (cause: unknown): string => {
  if (isCliTaggedError(cause)) return formatTaggedCliError(cause)
  if (Predicate.isObject(cause) && "message" in cause && Predicate.isString(cause.message)) {
    return cause.message
  }
  return String(cause)
}

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
        return Effect.fail(
          new CliError({ message: `Recipe module is not an object: ${resolvedRecipe}` }),
        )
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
      return Effect.fail(
        new CliError({ message: `Could not find an exported Recipe in ${resolvedRecipe}` }),
      )
    }),
  )

const JsonText = Schema.fromJsonString(Schema.Unknown)

export const runCli = (options: CliOptions): Effect.Effect<void, CliError | CliMatchFoundError> =>
  Effect.gen(function* () {
    const targetCwd =
      options.cwd !== undefined ? Path.resolve(process.cwd(), options.cwd) : process.cwd()
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
    const workspaceLayer = workspaceLayerNode({ projects: [app] }, { cwd: targetCwd })
    const runtimeLayer = Layer.merge(workspaceLayer, nodeLayer)

    const noColorConfig = yield* Config.string("NO_COLOR").pipe(Config.option, Effect.orDie)
    const useColor = options.noColor !== true && Option.isNone(noColorConfig)
    const hooks: RecipeExecutionHooks = {
      onPreview: (_plan, preview) => Console.log(renderPlanPreview(preview, { color: useColor })),
      onVerified: (_plan, _preview, verified) =>
        Console.log(renderDiagnosticDiff(verified.diagnosticDiff, { color: useColor })),
    }

    yield* Effect.gen(function* () {
      const workspace = yield* Workspace

      if (options.mode === "scan") {
        const { plan } = yield* executeRecipe(recipe, options.input, { mode: "plan" })
        const report = yield* workspace.withSnapshot(
          {},
          Effect.gen(function* () {
            const snapshot = yield* WorkspaceSnapshot
            return yield* buildAuditReport(plan, snapshot)
          }),
        )

        const format = options.format ?? "text"
        if (format === "json") {
          yield* Console.log(renderAuditJson(report))
        } else if (format === "csv") {
          yield* Console.log(renderAuditCsv(report))
        } else {
          yield* Console.log(renderAuditText(report, { color: useColor }))
        }

        if (options.failOnMatch === true && report.totalMatches > 0) {
          return yield* new CliMatchFoundError({
            matches: report.totalMatches,
            files: report.totalFiles,
          })
        }
        return
      }

      if (options.mode === "verify" || options.mode === "apply") {
        if (options.mode === "apply") {
          const execution = yield* executeRecipe(recipe, options.input, {
            mode: "apply",
            hooks,
          }).pipe(Effect.provide(applicationLayerNode))
          yield* Console.log(
            `\n✔ Applied ${execution.receipt.outputs.length} file changes successfully!`,
          )
        } else {
          yield* executeRecipe(recipe, options.input, { mode: "verify", hooks })
        }
        return
      }

      yield* executeRecipe(recipe, options.input, { mode: "preview", hooks })
    }).pipe(
      Effect.provide(runtimeLayer),
      Effect.mapError((cause) => {
        if (cause instanceof CliMatchFoundError) return cause
        return new CliError({ message: formatCliError(cause) })
      }),
    )
  })
