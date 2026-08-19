import { path as Path, nodeFsPromises as Fs } from "./platform/node.ts"
import { fileURLToPath } from "node:url"
import { describe, effect, expect } from "@effect/vitest"
import { Effect, Layer, type Stream } from "effect"
import type { CallExpression, Node } from "typescript/unstable/ast"
import { Application, Pattern, Plan, Recipe, Verification, Workspace, type Query } from "./index.ts"
import { applicationLayerNode } from "./Node/index.ts"
import { wrapTargetInput, type WrapTargetInput } from "./test/wrap-target-input.ts"
import { migrateImportSource, type MigrateImportSourceInput } from "./test/migrate-import-source.ts"

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false
type Assert<Value extends true> = Value

// --- Type-level contract -------------------------------------------------

export type _RecipeInputInference = Assert<
  Equal<Parameters<typeof wrapTargetInput.run>[0], WrapTargetInput>
>

declare const _anyProject: Parameters<typeof Query.calls>[0]
export type _CallInference = Assert<
  Equal<
    ReturnType<typeof Query.calls> extends Stream.Stream<infer S, infer _E, infer _R>
      ? S extends Query.Selection<infer Node>
        ? Node
        : never
      : never,
    CallExpression
  >
>

const _rawPlanIsNotApplicationAuthority = (plan: Plan.TransformationPlan) =>
  // @ts-expect-error — Application accepts only a Verified Plan
  Application.apply(plan)
void _rawPlanIsNotApplicationAuthority

const _verifiedPlanIsApplicationAuthority = (verified: Verification.VerifiedPlan) =>
  Application.apply(verified)
void _verifiedPlanIsApplicationAuthority

const _booleanPredicate = Pattern.predicate("boolean-node", (_node: Node) => true)
type PredicateOutput<P> = P extends Pattern.Pattern<infer _N, infer Out> ? Out : never
export type _BooleanPredicateYieldsNode = Assert<
  Equal<PredicateOutput<typeof _booleanPredicate>, Node>
>

// --- End-to-end pipeline ---------------------------------------------------

const fixtureSource = fileURLToPath(new URL("../fixtures/recipe/", import.meta.url))
const stressFixture = fileURLToPath(new URL("../fixtures/stress/", import.meta.url))

const withFixture = <A, E, R>(
  fixturePath: string,
  use: (
    root: string,
    app: Workspace.ConfiguredProject,
    workspaceLayer: Layer.Layer<Workspace.Workspace, any>,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, unknown, Exclude<R, Workspace.Workspace>> =>
  Effect.acquireUseRelease(
    Effect.tryPromise(async () => {
      const root = await Fs.mkdtemp("/tmp/safemods-api-")
      await Fs.cp(fixturePath, root, { recursive: true })
      return root
    }),
    (root) => {
      const app = Workspace.ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
      const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })
      return use(root, app, workspaceLayer).pipe(Effect.provide(workspaceLayer))
    },
    (root) =>
      Effect.tryPromise(() => Fs.rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
  )

describe("candidate public API (@effect/vitest)", () => {
  effect(
    "runs query → plan → preview → verify → apply as one typed pipeline",
    () =>
      withFixture(fixtureSource, (root, app, workspaceLayer) =>
        Effect.gen(function* () {
          const input: WrapTargetInput = {
            project: app,
            declarationFile: "src/library.ts",
            property: "value",
          }
          const mainLayer = applicationLayerNode.pipe(Layer.provideMerge(workspaceLayer))

          const { plan, preview, receipt, verified } = yield* Effect.gen(function* () {
            const plan = yield* Recipe.run(wrapTargetInput, input)
            const preview = yield* Verification.of(plan)
            const verified = yield* Verification.verify(plan, wrapTargetInput, input)
            const receipt = yield* Application.apply(verified)
            return { plan, preview, verified, receipt }
          }).pipe(Effect.provide(mainLayer))

          expect(plan.recipe.name).toBe("wrap-target-input")
          expect(plan.measurements?.matches).toBe(2)
          expect(preview.files).toHaveLength(2)
          expect(verified.receipt.diagnosticDelta).toBe(0)
          expect(verified.receipt.idempotenceChecked).toBe(true)
          expect(verified.receipt.policyResults.length).toBeGreaterThan(0)
          expect(receipt.outputs).toHaveLength(2)

          const consumer = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
          )
          const reexport = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/reexport-consumer.ts"), "utf8"),
          )
          expect(consumer).toContain("renamed(/* keep this comment */ { value: 1 })")
          expect(consumer).toContain("const first  =")
          expect(consumer).toContain("other(2)")
          expect(consumer).toContain("local.target(3)")
          expect(reexport).toContain("publicTarget({ value: 4 })")

          // A durable plan crosses the process boundary intact.
          const roundTripped = yield* Plan.parsePlan(Plan.serializePlan(plan))
          expect(roundTripped.planId).toBe(plan.planId)

          // After application the recipe is a no-op: the reran plan has no edits.
          // Reopen the workspace so the compiler observes the newly written snapshot.
          const freshWorkspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })
          const second = yield* Recipe.run(wrapTargetInput, input).pipe(
            Effect.provide(freshWorkspaceLayer),
          )
          expect(second.edits).toHaveLength(0)
          expect(second.measurements?.matches).toBe(0)
        }),
      ),
    60_000,
  )

  effect(
    "produces identical plan IDs for identical inputs",
    () =>
      withFixture(fixtureSource, (_, app) =>
        Effect.gen(function* () {
          const input: WrapTargetInput = {
            project: app,
            declarationFile: "src/library.ts",
            property: "value",
          }
          const [first, second] = yield* Effect.all([
            Recipe.run(wrapTargetInput, input),
            Recipe.run(wrapTargetInput, input),
          ])
          expect(first.planId).toBe(second.planId)
        }),
      ),
    60_000,
  )

  effect(
    "migrates an import source, preserving quote style and trivia",
    () =>
      withFixture(stressFixture, (root, app, workspaceLayer) =>
        Effect.gen(function* () {
          const input: MigrateImportSourceInput = {
            project: app,
            from: "./legacy.js",
            to: "./replacement.js",
          }
          const mainLayer = applicationLayerNode.pipe(Layer.provideMerge(workspaceLayer))

          const { plan, receipt } = yield* Effect.gen(function* () {
            const plan = yield* Recipe.run(migrateImportSource, input)
            const verified = yield* Verification.verify(plan, migrateImportSource, input)
            const receipt = yield* Application.apply(verified)
            return { plan, receipt }
          }).pipe(Effect.provide(mainLayer))

          expect(plan.edits).toHaveLength(1)
          expect(receipt.outputs).toHaveLength(1)

          const consumer = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/import-consumer.ts"), "utf8"),
          )
          expect(consumer).toContain("from './replacement.js'")
          expect(consumer).toContain("/* preserve import trivia */")
          expect(consumer).toContain("const importResult  =")
        }),
      ),
    60_000,
  )
})
