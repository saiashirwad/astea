/**
 * safemods CLI — Interactive command-line runner and inspection tool.
 */
import { path as Path } from "../platform/node.ts"
import { Config, Console, Data, Effect, Layer, Option, Predicate, Schema } from "effect"
import { Application, layerNode as planApplicationLayerNode } from "../api/application.ts"
import { type Recipe, Recipe as RecipeApi } from "../api/recipe.ts"
import { Preview, Verification } from "../api/verification.ts"
import { ConfiguredProject, Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import type {
  AuditCriterionRecord,
  AuditFinding,
  AuditReport,
} from "./audit.ts"
import {
  buildAuditReport,
  CliMatchFoundError,
  computeLineAndColumn,
  renderAuditCsv,
  renderAuditJson,
  renderAuditText,
} from "./audit.ts"
import { renderDiagnosticDiff, renderPlanPreview } from "./diff.ts"
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
  readonly cwd?: string
  readonly mode?: "preview" | "verify" | "apply" | "scan"
  readonly format?: "text" | "json" | "csv"
  readonly failOnMatch?: boolean
  readonly toolSchema?: boolean
  readonly noColor?: boolean
}

export class CliError extends Data.TaggedError("CliError")<{
  readonly message: string
}> {}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type */
const formatCliError = (cause: unknown): string => {
  if (cause && typeof cause === "object") {
    const raw = cause as Record<string, unknown>
    if ("_tag" in raw && typeof raw._tag === "string") {
      switch (raw._tag) {
        case "VerificationFailure": {
          const v = raw as { readonly policy: string; readonly detail: string }
          return `Verification Failed: Policy '${v.policy}' failed (${v.detail})`
        }
        case "RecipeInputError": {
          const r = raw as { readonly recipe: string; readonly cause: unknown }
          return `Invalid Recipe Input for '${r.recipe}': ${String(r.cause)}`
        }
        case "SymbolNotFound": {
          const s = raw as { readonly name: string; readonly fileName: string }
          return `Symbol Not Found: '${s.name}' was not found in '${s.fileName}'`
        }
        case "FileNotFound": {
          const f = raw as { readonly projectId: string; readonly fileName: string }
          return `File Not Found: '${f.fileName}' in project '${f.projectId}'`
        }
        case "StalePlanError": {
          const sp = raw as { readonly projectId: string; readonly fileName: string }
          return `Stale Plan: '${sp.fileName}' in project '${sp.projectId}' was modified after snapshot`
        }
        case "EditConflict": {
          const ec = raw as { readonly left: { readonly fileName: string; readonly start: number; readonly end: number } }
          return `Edit Conflict: Overlapping edits detected in '${ec.left.fileName}'`
        }
        case "InvalidEdit": {
          const ie = raw as { readonly edit: { readonly fileName: string }; readonly reason: string }
          return `Invalid Edit (${ie.reason}) in '${ie.edit.fileName}'`
        }
        case "CliError": {
          const ce = raw as { readonly message: string }
          return ce.message
        }
      }
    }
    if ("message" in raw && Predicate.isString(raw.message)) {
      return raw.message
    }
  }
  return String(cause)
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type */

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

export const runCli = (options: CliOptions): Effect.Effect<void, CliError | CliMatchFoundError> =>
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
      const workspace = yield* Workspace
      const plan = yield* RecipeApi.run(recipe, options.input)

      if (options.mode === "scan") {
        const report = yield* workspace.withSnapshot({}, Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          return yield* buildAuditReport(plan, snapshot)
        }))

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
      Effect.mapError((cause) => {
        if (
          cause !== null &&
          Predicate.isObject(cause) &&
          "_tag" in cause &&
          cause._tag === "CliMatchFoundError"
        ) {
          // SAFETY: Tag check confirms CliMatchFoundError shape.
          return cause as CliMatchFoundError
        }
        return new CliError({ message: formatCliError(cause) })
      }),
    )
  })
