import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Schema } from "effect"
import type { CallExpression } from "typescript/unstable/ast"
import { describe, expect, it } from "vitest"
import {
  Application,
  computeDiagnosticDiff,
  ConfiguredProject,
  Criterion,
  type DiagnosticRecord,
  Draft,
  overlay,
  Pattern,
  planApplicationLayerNode,
  Policy,
  Preview,
  Query,
  Recipe,
  RecipeInputError,
  Verification,
  VerificationFailure,
  Workspace,
  WorkspaceSnapshot,
} from "./index.ts"

const fixtureSource = fileURLToPath(new URL("../../fixtures/recipe/", import.meta.url))

describe("declarative transformations API", () => {
  // ---------------------------------------------------------------------------
  // 1. In-Memory Virtual Snapshot Transitions (snapshot.overlay)
  // ---------------------------------------------------------------------------
  describe("in-memory snapshot transitions", () => {
    it("chains semantic queries across in-memory overlays without touching disk", async () => {
      const root = await Fs.mkdtemp("/tmp/teatime-overlay-")
      await Fs.cp(fixtureSource, root, { recursive: true })

      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
      const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })

      try {
        await Effect.runPromise(
          Effect.gen(function*() {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot({}, Effect.gen(function*() {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)

              // Stage 1: Propose an edit to library.ts in memory
              const libFile = yield* project.sourceFile("src/library.ts")
              expect(libFile).toBeDefined()

              const draft1 = yield* Draft.imports.addNamed(project, "src/library.ts", {
                module: "effect",
                name: "Option",
              })
              expect(draft1.edits).toHaveLength(1)

              // Stage 2: Evaluate inside in-memory overlay
              yield* overlay(draft1, Effect.gen(function*() {
                const overlaySnapshot = yield* WorkspaceSnapshot
                const overlayProject = yield* overlaySnapshot.project(app)

                const updatedLib = yield* overlayProject.sourceFile("src/library.ts")
                expect(updatedLib?.text).toContain('import { Option } from "effect"')

                // Verify that disk was untouched
                const diskContent = yield* Effect.tryPromise(() =>
                  Fs.readFile(Path.join(root, "src/library.ts"), "utf8")
                )
                expect(diskContent).not.toContain('import { Option } from "effect"')
              }))
            }))
          }).pipe(Effect.provide(workspaceLayer)),
        )
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }, 60_000)
  })

  // ---------------------------------------------------------------------------
  // 2. Declarative Semantic Query Algebra & Pattern Matchers
  // ---------------------------------------------------------------------------
  describe("pattern matchers and query algebra", () => {
    it("matches AST patterns declaratively and extracts typed bindings with evidence", async () => {
      const root = await Fs.mkdtemp("/tmp/teatime-pattern-")
      await Fs.cp(fixtureSource, root, { recursive: true })

      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
      const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })

      try {
        await Effect.runPromise(
          Effect.gen(function*() {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot({}, Effect.gen(function*() {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              const targetSymbol = yield* project.symbolNamed("target", { within: "src/library.ts" })

              // Match call expressions with target symbol expression and single argument
              const callPattern = Pattern.callExpression({
                expression: Pattern.identifier({ resolvesTo: targetSymbol }),
                arguments: Pattern.tuple([Pattern.bind("arg", Pattern.any)]),
              })

              const matches = yield* Query.match(project, callPattern).pipe(Query.collect)
              expect(matches.length).toBe(2)

              for (const match of matches) {
                expect(match.value.call).toBeDefined()
                expect(match.value.args[0]!.arg).toBeDefined()
                expect(match.evidence.length).toBeGreaterThan(0)
              }
            }))
          }).pipe(Effect.provide(workspaceLayer)),
        )
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }, 60_000)

    it("evaluates algebraic criterion combinators (all, any, not)", async () => {
      const root = await Fs.mkdtemp("/tmp/teatime-criteria-")
      await Fs.cp(fixtureSource, root, { recursive: true })

      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
      const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })

      try {
        await Effect.runPromise(
          Effect.gen(function*() {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot({}, Effect.gen(function*() {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              const target = yield* project.symbolNamed("target", { within: "src/library.ts" })

              // Combined criterion: resolves to target AND text matches argument number
              const combinedCriterion = Criterion.all(
                Query.resolvesTo(target, { location: (call: CallExpression) => call.expression }),
                Criterion.not(Query.textMatches(/nonexistent/)),
              )

              const calls = yield* Query.calls(project).pipe(
                Query.where(combinedCriterion),
                Query.collect,
              )
              expect(calls.length).toBe(2)
            }))
          }).pipe(Effect.provide(workspaceLayer)),
        )
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }, 60_000)
  })

  // ---------------------------------------------------------------------------
  // 3. Higher-Order Recipe Combinators & Schema Validation
  // ---------------------------------------------------------------------------
  describe("recipe combinators & schema validation", () => {
    it("validates recipe inputs with Effect Schema", async () => {
      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })

      const schemaRecipe = Recipe.define("schema-recipe", {
        version: "1.0.0",
        schema: Schema.Struct({
          propertyName: Schema.NonEmptyString,
          multiplier: Schema.Number,
        }),
        run: (input) =>
          Effect.gen(function*() {
            expect(input.propertyName).toBe("validProp")
            expect(input.multiplier).toBe(42)
            return Draft.empty
          }),
      })

      const root = await Fs.mkdtemp("/tmp/teatime-schema-")
      await Fs.cp(fixtureSource, root, { recursive: true })
      const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })

      try {
        // Valid input passes
        await Effect.runPromise(
          Recipe.run(schemaRecipe, { propertyName: "validProp", multiplier: 42 }).pipe(
            Effect.provide(workspaceLayer),
          ),
        )

        // Invalid input fails with RecipeInputError
        const failure = await Effect.runPromise(
          Recipe.run(schemaRecipe, { propertyName: "", multiplier: 42 } as any).pipe(
            Effect.provide(workspaceLayer),
            Effect.flip,
          ),
        )
        expect(failure).toBeInstanceOf(RecipeInputError)
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }, 60_000)

    it("composes sequential recipes with Recipe.pipe and in-memory transitions", async () => {
      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })

      const addImportRecipe = Recipe.define("add-import", {
        version: "1.0.0",
        run: () =>
          Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)
            return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
              module: "./library.js",
              name: "TargetInput",
            })
          }),
      })

      const addSecondImportRecipe = Recipe.define("add-second-import", {
        version: "1.0.0",
        run: () =>
          Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)
            // Second recipe runs against the overlay
            return yield* Draft.imports.addNamed(project, "src/reexport-consumer.ts", {
              module: "./library.js",
              name: "TargetInput",
            })
          }),
      })

      const pipedRecipe = Recipe.pipe(addImportRecipe, addSecondImportRecipe)

      const root = await Fs.mkdtemp("/tmp/teatime-pipe-")
      await Fs.cp(fixtureSource, root, { recursive: true })
      const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })
      const mainLayer = planApplicationLayerNode.pipe(Layer.provideMerge(workspaceLayer))

      try {
        const plan = await Effect.runPromise(
          Recipe.run(pipedRecipe, undefined).pipe(Effect.provide(workspaceLayer)),
        )
        expect(plan.edits.length).toBeGreaterThanOrEqual(2)

        const verified = await Effect.runPromise(
          Verification.verify(plan, pipedRecipe, undefined).pipe(Effect.provide(workspaceLayer)),
        )
        await Effect.runPromise(Application.apply(verified).pipe(Effect.provide(mainLayer)))

        const consumerContent = await Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
        expect(consumerContent).toContain("TargetInput")
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }, 60_000)

    it("composes concurrent recipes with Recipe.all and executes conditionally with Recipe.branch", async () => {
      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })

      const recipeA = Recipe.define("recipe-a", {
        version: "1.0.0",
        run: () =>
          Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)
            return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
              module: "effect",
              name: "Chunk",
            })
          }),
      })

      const recipeB = Recipe.define("recipe-b", {
        version: "1.0.0",
        run: () =>
          Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)
            return yield* Draft.imports.addNamed(project, "src/reexport-consumer.ts", {
              module: "effect",
              name: "HashSet",
            })
          }),
      })

      const parallelRecipe = Recipe.all([recipeA, recipeB])
      const branchedRecipe = Recipe.branch(
        () => true,
        parallelRecipe,
        Recipe.define("noop", { version: "1.0.0", run: () => Effect.succeed(Draft.empty) }),
      )

      const root = await Fs.mkdtemp("/tmp/teatime-all-")
      await Fs.cp(fixtureSource, root, { recursive: true })
      const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })

      try {
        const plan = await Effect.runPromise(
          Recipe.run(branchedRecipe, undefined).pipe(Effect.provide(workspaceLayer)),
        )
        expect(plan.edits).toHaveLength(2)
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }, 60_000)
  })

  // ---------------------------------------------------------------------------
  // 4. High-Fidelity Syntactic Draft Combinators
  // ---------------------------------------------------------------------------
  describe("syntactic draft combinators", () => {
    it("manipulates imports, call arguments, and object fields preserving formatting", async () => {
      const root = await Fs.mkdtemp("/tmp/teatime-drafts-")
      await Fs.cp(fixtureSource, root, { recursive: true })

      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
      const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })
      const mainLayer = planApplicationLayerNode.pipe(Layer.provideMerge(workspaceLayer))

      const draftTestRecipe = Recipe.define("draft-test-recipe", {
        version: "1.0.0",
        run: () =>
          Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)

            // 1. Add import
            const d1 = yield* Draft.imports.addNamed(project, "src/consumer.ts", {
              module: "./library.js",
              name: "TargetInput",
            })

            // 2. Wrap call argument
            const calls = yield* Query.calls(project).pipe(Query.collect)
            const targetCall = calls[0]!.value
            const d2 = yield* Draft.args.wrap(project, targetCall, 0, (text) => `/* wrapped */ { value: ${text} }`)

            return Draft.concat(d1, d2)
          }),
      })

      try {
        const plan = await Effect.runPromise(
          Recipe.run(draftTestRecipe, undefined).pipe(Effect.provide(workspaceLayer)),
        )
        const verified = await Effect.runPromise(
          Verification.verify(plan, draftTestRecipe, undefined).pipe(Effect.provide(workspaceLayer)),
        )
        await Effect.runPromise(Application.apply(verified).pipe(Effect.provide(mainLayer)))

        const consumerContent = await Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
        expect(consumerContent).toContain("TargetInput")
        expect(consumerContent).toContain("/* keep this comment */ /* wrapped */ { value: 1 }")
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }, 60_000)
  })

  // ---------------------------------------------------------------------------
  // 5. Diagnostic Diffs and Declarative Policy Expressions
  // ---------------------------------------------------------------------------
  describe("diagnostic diffs and verification policies", () => {
    it("computes diagnostic diffs accurately", () => {
      const baseline: ReadonlyArray<DiagnosticRecord> = [
        { code: 2304, message: "Cannot find name 'foo'", category: "error", fileName: "a.ts", start: 10, length: 3 },
        { code: 6133, message: "'x' is declared but its value is never read", category: "warning", fileName: "a.ts", start: 20, length: 1 },
      ]

      const proposed: ReadonlyArray<DiagnosticRecord> = [
        { code: 6133, message: "'x' is declared but its value is never read", category: "warning", fileName: "a.ts", start: 20, length: 1 },
        { code: 2322, message: "Type 'string' is not assignable to type 'number'", category: "error", fileName: "b.ts", start: 5, length: 6 },
      ]

      const diff = computeDiagnosticDiff(baseline, proposed)
      expect(diff.unchanged).toHaveLength(1)
      expect(diff.unchanged[0]!.code).toBe(6133)
      expect(diff.resolved).toHaveLength(1)
      expect(diff.resolved[0]!.code).toBe(2304)
      expect(diff.introduced).toHaveLength(1)
      expect(diff.introduced[0]!.code).toBe(2322)
    })

    it("enforces declarative policies during verification", async () => {
      const root = await Fs.mkdtemp("/tmp/teatime-policy-")
      await Fs.cp(fixtureSource, root, { recursive: true })

      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
      const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })

      // Recipe with custom policy requiring non-empty match and no new errors
      const validRecipe = Recipe.define("policy-valid", {
        version: "1.0.0",
        policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
        run: () =>
          Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)
            return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
              module: "./library.js",
              name: "TargetInput",
            })
          }),
      })

      // Recipe with failing policy (expecting 999 matches)
      const failingRecipe = Recipe.define("policy-failing", {
        version: "1.0.0",
        policies: [Policy.matches({ min: 999 })],
        run: () =>
          Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)
            return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
              module: "./library.js",
              name: "TargetInput",
            })
          }),
      })

      try {
        // Valid passes verification
        const validPlan = await Effect.runPromise(
          Recipe.run(validRecipe, undefined).pipe(Effect.provide(workspaceLayer)),
        )
        const verified = await Effect.runPromise(
          Verification.verify(validPlan, validRecipe, undefined).pipe(Effect.provide(workspaceLayer)),
        )
        expect(verified.diagnosticDiff).toBeDefined()

        // Failing policy is rejected during verification
        const failingPlan = await Effect.runPromise(
          Recipe.run(failingRecipe, undefined).pipe(Effect.provide(workspaceLayer)),
        )
        const failure = await Effect.runPromise(
          Verification.verify(failingPlan, failingRecipe, undefined).pipe(
            Effect.provide(workspaceLayer),
            Effect.flip,
          ),
        )
        expect(failure).toBeInstanceOf(VerificationFailure)
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }, 60_000)
  })
})
