/**
 * safemods — Declarative API Tour
 *
 * This example walks through the 5 core pillars of safemods:
 * 1. Declarative AST Pattern Matching (`Pattern` & `Query.match`)
 * 2. Algebraic Criteria Combinators (`Criterion.all`, `Criterion.not`)
 * 3. High-Fidelity Draft Mutations (`Draft.replaceEach`, `Draft.imports`, `Draft.files`)
 * 4. In-Memory Virtual Overlays & Algebraic Recipes (`Recipe.pipe`, `Recipe.all`, `Recipe.branch`)
 * 5. Diagnostic Diffs & Declarative Policies (`Policy.noNewErrors`, `Policy.fixesError`, `Policy.idempotent`)
 */
import { nodeFsPromises as Fs } from "../src/platform/node.ts"
import { fileURLToPath } from "node:url"
import { isObjectLiteralExpression } from "typescript/unstable/ast/is"
import { Effect, Layer, Schema } from "effect"
import * as Application from "safemods/Application"
import * as Draft from "safemods/Draft"
import { applicationLayerNode, workspaceLayerNode } from "safemods/Node"
import * as Policy from "safemods/Policy"
import { Criterion } from "safemods/Query"
import * as Query from "safemods/Query"
import * as Recipe from "safemods/Recipe"
import * as Verification from "safemods/Verification"
import { ConfiguredProject, WorkspaceSnapshot } from "safemods/Workspace"

const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })

export const WrapOptionsSchema = Schema.Struct({
  propertyName: Schema.NonEmptyString,
  addTypeImport: Schema.Boolean,
})
export type WrapOptions = typeof WrapOptionsSchema.Type

export const wrapTargetRecipe = Recipe.define("wrap-target-call-sites", {
  version: "1.0.0",
  schema: WrapOptionsSchema,
  policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
  run: (input: WrapOptions) =>
    Effect.gen(function* () {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(app)
      const targetSymbol = yield* project.symbolNamed("target", { within: "src/library.ts" })

      const calls = yield* Query.calls(project).pipe(
        Query.where(Query.resolvesTo(targetSymbol, { location: (call) => call.expression })),
        Query.filter(
          ({ value: call }) =>
            call.arguments.length === 1 && !isObjectLiteralExpression(call.arguments[0]!),
        ),
        Query.collect,
      )

      const wrapDraft = yield* Draft.replaceEach(calls, ({ value: call }) => {
        const argument = call.arguments[0]!
        return { node: argument, text: `{ ${input.propertyName}: ${argument.getText()} }` }
      })

      const importDraft = input.addTypeImport
        ? yield* Draft.imports.addNamed(project, "src/consumer.ts", {
            module: "./library.js",
            name: "TargetInput",
          })
        : Draft.empty

      return Draft.concat(wrapDraft, importDraft)
    }),
})

export const cleanupRecipe = Recipe.define("cleanup-deprecated", {
  version: "1.0.0",
  schema: WrapOptionsSchema,
  policies: [Policy.noNewErrors()],
  run: (_input: WrapOptions) =>
    Effect.gen(function* () {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(app)

      const deprecatedCalls = yield* Query.calls(project).pipe(
        Query.where(
          Criterion.all(Query.hasJSDocTag("deprecated"), Criterion.not(Query.textMatches(/keep/))),
        ),
        Query.collect,
      )

      return yield* Draft.replaceEach(deprecatedCalls, () => "/* removed deprecated call */")
    }),
})

export const fullMigrationPipeline = Recipe.pipe(wrapTargetRecipe, cleanupRecipe)

export const runTour = Effect.gen(function* () {
  const input: WrapOptions = { propertyName: "value", addTypeImport: true }

  const plan = yield* Recipe.run(wrapTargetRecipe, input)
  console.log(`[Plan Created] ID: ${plan.planId}, Edits: ${plan.edits.length}`)

  const preview = yield* Verification.of(plan)
  console.log(`[Preview Generated] Files affected: ${preview.files.length}`)

  const verified = yield* Verification.verify(plan, wrapTargetRecipe, input)
  console.log(
    `[Verification Passed] Diagnostic Delta: ${verified.receipt.diagnosticDelta}, Idempotence: ${verified.receipt.idempotenceChecked}`,
  )
  console.log(
    `[Diagnostic Diff] Introduced: ${verified.diagnosticDiff.introduced.length}, Resolved: ${verified.diagnosticDiff.resolved.length}`,
  )

  const receipt = yield* Application.apply(verified)
  console.log(`[Application Applied] Confirmed output files: ${receipt.outputs.length}`)

  return receipt
})

async function main() {
  const fixtureSource = fileURLToPath(new URL("../fixtures/recipe/", import.meta.url))
  const tmpRoot = await Fs.mkdtemp("/tmp/safemods-example-")
  await Fs.cp(fixtureSource, tmpRoot, { recursive: true })

  const workspaceLayer = workspaceLayerNode({ projects: [app] }, { cwd: tmpRoot })
  const appLayer = applicationLayerNode.pipe(Layer.provideMerge(workspaceLayer))

  try {
    await Effect.runPromise(runTour.pipe(Effect.provide(appLayer)))
    console.log("Tour completed successfully!")
  } finally {
    await Fs.rm(tmpRoot, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error)
}
