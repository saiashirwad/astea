/**
 * teatime — Declarative API Tour
 *
 * This example walks through the 5 core pillars of teatime:
 * 1. Declarative AST Pattern Matching (`Pattern` & `Query.match`)
 * 2. Algebraic Criteria Combinators (`Criterion.all`, `Criterion.not`)
 * 3. High-Fidelity Syntactic Draft Combinators (`Draft.imports`, `Draft.args`, `Draft.objectLiteral`)
 * 4. In-Memory Virtual Overlays & Algebraic Recipes (`Recipe.pipe`, `Recipe.all`, `Recipe.branch`)
 * 5. Diagnostic Diffs & Declarative Policies (`Policy.noNewErrors`, `Policy.fixesError`, `Policy.idempotent`)
 */
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Schema } from "effect"
import {
  Application,
  computeDiagnosticDiff,
  ConfiguredProject,
  Criterion,
  Draft,
  Pattern,
  planApplicationLayerNode,
  Policy,
  Preview,
  Query,
  Recipe,
  Verification,
  Workspace,
  WorkspaceSnapshot,
} from "../src/api/index.ts"

const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })

// -----------------------------------------------------------------------------
// 1. Define a Typed Recipe with Input Schema
// -----------------------------------------------------------------------------

export const WrapOptionsSchema = Schema.Struct({
  propertyName: Schema.NonEmptyString,
  addTypeImport: Schema.Boolean,
})
export type WrapOptions = typeof WrapOptionsSchema.Type

export const wrapTargetRecipe = Recipe.define("wrap-target-call-sites", {
  version: "1.0.0",
  schema: WrapOptionsSchema,
  policies: [
    Policy.matches({ min: 1 }),
    Policy.noNewErrors(),
    Policy.idempotent(),
  ],
  run: (input: WrapOptions) =>
    Effect.gen(function*() {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(app)
      const targetSymbol = yield* project.symbolNamed("target", { within: "src/library.ts" })

      // Pattern: match call expressions resolving to `target`, extracting the single argument
      const callPattern = Pattern.callExpression({
        expression: Pattern.identifier({ resolvesTo: targetSymbol }),
        arguments: Pattern.tuple([
          Pattern.bind("arg", Pattern.not(Pattern.objectLiteral())),
        ]),
      })

      const matches = yield* Query.match(project, callPattern).pipe(Query.collect)

      // Propose edits using high-fidelity draft combinator
      const wrapDraft = yield* Draft.replaceEach(matches, ({ value: matched }) => {
        const argNode = matched.args[0]!.arg
        return {
          node: argNode,
          text: `{ ${input.propertyName}: ${argNode.getText(argNode.getSourceFile())} }`,
        }
      })

      // Optionally add named import to consumer files
      const importDraft = input.addTypeImport
        ? yield* Draft.imports.addNamed(project, "src/consumer.ts", {
            module: "./library.js",
            name: "TargetInput",
          })
        : Draft.empty

      return Draft.concat(wrapDraft, importDraft)
    }),
})

// -----------------------------------------------------------------------------
// 2. Multi-Stage Pipeline Composition with Recipe.pipe
// -----------------------------------------------------------------------------

export const cleanupRecipe = Recipe.define("cleanup-deprecated", {
  version: "1.0.0",
  policies: [Policy.noNewErrors()],
  run: () =>
    Effect.gen(function*() {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(app)

      // Query declarations with @deprecated JSDoc tag
      const deprecatedCalls = yield* Query.calls(project).pipe(
        Query.where(
          Criterion.all(
            Query.hasJSDocTag("deprecated"),
            Criterion.not(Query.textMatches(/keep/)),
          ),
        ),
        Query.collect,
      )

      return yield* Draft.replaceEach(deprecatedCalls, () => "/* removed deprecated call */")
    }),
})

// Chaining recipes purely in memory using TypeScript 7 virtual overlays
export const fullMigrationPipeline = Recipe.pipe(
  wrapTargetRecipe,
  cleanupRecipe,
)

// -----------------------------------------------------------------------------
// 3. Execution Pipeline (Query → Plan → Preview → Verify → Apply)
// -----------------------------------------------------------------------------

export const runTour = Effect.gen(function*() {
  const input: WrapOptions = { propertyName: "value", addTypeImport: true }

  // Step 1: Run recipe to create durable, content-addressed Transformation Plan
  const plan = yield* Recipe.run(wrapTargetRecipe, input)
  console.log(`[Plan Created] ID: ${plan.planId}, Edits: ${plan.edits.length}`)

  // Step 2: Generate read-only Preview
  const preview = yield* Preview.of(plan)
  console.log(`[Preview Generated] Files affected: ${preview.files.length}`)

  // Step 3: Verify plan against isolated virtual compiler authority
  const verified = yield* Verification.verify(plan, wrapTargetRecipe, input)
  console.log(
    `[Verification Passed] Diagnostic Delta: ${verified.receipt.diagnosticDelta}, Idempotence: ${verified.receipt.idempotenceChecked}`,
  )
  console.log(
    `[Diagnostic Diff] Introduced: ${verified.diagnosticDiff.introduced.length}, Resolved: ${verified.diagnosticDiff.resolved.length}`,
  )

  // Step 4: Explicit Application (the ONLY filesystem write)
  const receipt = yield* Application.apply(verified)
  console.log(`[Application Applied] Confirmed output files: ${receipt.outputs.length}`)

  return receipt
})

// -----------------------------------------------------------------------------
// 4. Standalone Runner with Temporary Fixture
// -----------------------------------------------------------------------------

async function main() {
  const fixtureSource = fileURLToPath(new URL("../fixtures/recipe/", import.meta.url))
  const tmpRoot = await Fs.mkdtemp("/tmp/teatime-example-")
  await Fs.cp(fixtureSource, tmpRoot, { recursive: true })

  const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: tmpRoot })
  const appLayer = planApplicationLayerNode.pipe(Layer.provideMerge(workspaceLayer))

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
