import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import type { CallExpression } from "typescript/unstable/ast"
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

const withFixture = <A, E, R>(
  use: (root: string, app: ConfiguredProject) => Effect.Effect<A, E, R>,
): Effect.Effect<A, unknown, Exclude<R, Workspace>> =>
  Effect.acquireUseRelease(
    Effect.tryPromise(async () => {
      const root = await Fs.mkdtemp("/tmp/teatime-decl-")
      await Fs.cp(fixtureSource, root, { recursive: true })
      return root
    }),
    (root) => {
      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
      const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })
      return use(root, app).pipe(Effect.provide(workspaceLayer))
    },
    (root) => Effect.tryPromise(() => Fs.rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
  )

describe("declarative transformations API (@effect/vitest)", () => {
  // ---------------------------------------------------------------------------
  // 1. In-Memory Virtual Snapshot Transitions (snapshot.overlay)
  // ---------------------------------------------------------------------------
  describe("in-memory snapshot transitions", () => {
    it("chains semantic queries across in-memory overlays without touching disk", () =>
      withFixture((root, app) =>
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
        })
      ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 2. Declarative Semantic Query Algebra & Pattern Matchers
  // ---------------------------------------------------------------------------
  describe("pattern matchers and query algebra", () => {
    it("matches AST patterns declaratively and extracts typed bindings with evidence", () =>
      withFixture((_, app) =>
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
        })
      ),
      60_000,
    )

    it("evaluates type assignability and type patterns declaratively", () =>
      withFixture((_, app) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot({}, Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)

            // 1. Query with type pattern matching
            const typedCallPattern = Pattern.callExpression({
              expression: Pattern.any,
              arguments: Pattern.tuple([
                Pattern.bind("arg", Pattern.typed({ assignableTo: "number" })),
              ]),
            })

            const matches = yield* Query.match(project, typedCallPattern).pipe(Query.collect)
            expect(matches.length).toBeGreaterThan(0)

            // 2. Query with typeAssignableTo criterion on identifiers
            const numberArgs = yield* Query.identifiers(project).pipe(
              Query.where(Query.typeAssignableTo("number")),
              Query.collect,
            )
            expect(numberArgs.length).toBeGreaterThan(0)

            // 3. Inspect type of node directly
            const firstCall = matches[0]!.value.call
            const callType = yield* Query.typeOf(project, firstCall)
            expect(callType).toBeDefined()
            const typeStr = yield* project.typeToString(callType!)
            expect(typeStr).toContain("number")
          }))
        })
      ),
      60_000,
    )

    it("evaluates algebraic criterion combinators (all, any, not)", () =>
      withFixture((_, app) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot({}, Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)
            const target = yield* project.symbolNamed("target", { within: "src/library.ts" })

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
        })
      ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 3. Higher-Order Recipe Combinators & Schema Validation
  // ---------------------------------------------------------------------------
  describe("recipe combinators & schema validation", () => {
    it("validates recipe inputs with Effect Schema", () =>
      withFixture((_, app) =>
        Effect.gen(function*() {
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

          // Valid input passes
          yield* Recipe.run(schemaRecipe, { propertyName: "validProp", multiplier: 42 })

          // Invalid input fails with RecipeInputError
          const failure = yield* Recipe.run(schemaRecipe, { propertyName: "", multiplier: 42 } as any).pipe(
            Effect.flip,
          )
          expect(failure).toBeInstanceOf(RecipeInputError)
        })
      ),
      60_000,
    )

    it("composes sequential recipes with Recipe.pipe and in-memory transitions", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
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
                return yield* Draft.imports.addNamed(project, "src/reexport-consumer.ts", {
                  module: "./library.js",
                  name: "TargetInput",
                })
              }),
          })

          const pipedRecipe = Recipe.pipe(addImportRecipe, addSecondImportRecipe)

          const plan = yield* Recipe.run(pipedRecipe, undefined)
          expect(plan.edits.length).toBeGreaterThanOrEqual(2)

          const verified = yield* Verification.verify(plan, pipedRecipe, undefined)
          yield* Application.apply(verified).pipe(
            Effect.provide(planApplicationLayerNode),
          )

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("TargetInput")
        })
      ),
      60_000,
    )

    it("composes concurrent recipes with Recipe.all and executes conditionally with Recipe.branch", () =>
      withFixture((_, app) =>
        Effect.gen(function*() {
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

          const plan = yield* Recipe.run(branchedRecipe, undefined)
          expect(plan.edits).toHaveLength(2)
        })
      ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 4. High-Fidelity Syntactic Draft Combinators & Symbol Rename
  // ---------------------------------------------------------------------------
  describe("syntactic draft combinators and rename", () => {
    it("manipulates imports, call arguments, and object fields preserving formatting", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
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
                const d2 = yield* Draft.args.wrap(
                  project,
                  targetCall,
                  0,
                  (text) => `/* wrapped */ { value: ${text} }`,
                )

                return Draft.concat(d1, d2)
              }),
          })

          const plan = yield* Recipe.run(draftTestRecipe, undefined)
          const verified = yield* Verification.verify(plan, draftTestRecipe, undefined)
          yield* Application.apply(verified).pipe(
            Effect.provide(planApplicationLayerNode),
          )

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("TargetInput")
          expect(consumerContent).toContain("/* keep this comment */ /* wrapped */ { value: 1 }")
        })
      ),
      60_000,
    )

    it("renames symbols across all declarations, imports, and usages with Draft.renameSymbol", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const renameRecipe = Recipe.define("rename-other-symbol", {
            version: "1.0.0",
            policies: [Policy.noNewErrors()],
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const otherSymbol = yield* project.symbolNamed("other", { within: "src/library.ts" })

                return yield* Draft.renameSymbol(project, otherSymbol, "transformedOther")
              }),
          })

          const plan = yield* Recipe.run(renameRecipe, undefined)
          expect(plan.edits.length).toBeGreaterThanOrEqual(2)

          const verified = yield* Verification.verify(plan, renameRecipe, undefined)
          yield* Application.apply(verified).pipe(
            Effect.provide(planApplicationLayerNode),
          )

          const libContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/library.ts"), "utf8")
          )
          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )

          expect(libContent).toContain("function transformedOther(value: number)")
          expect(consumerContent).toContain("import { transformedOther, target as renamed }")
          expect(consumerContent).toContain("transformedOther(2)")
        })
      ),
      60_000,
    )
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

    it("enforces declarative policies during verification", () =>
      withFixture((_, app) =>
        Effect.gen(function*() {
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

          // Valid passes verification
          const validPlan = yield* Recipe.run(validRecipe, undefined)
          const verified = yield* Verification.verify(validPlan, validRecipe, undefined)
          expect(verified.diagnosticDiff).toBeDefined()

          // Failing policy is rejected during verification
          const failingPlan = yield* Recipe.run(failingRecipe, undefined)
          const failure = yield* Verification.verify(failingPlan, failingRecipe, undefined).pipe(
            Effect.flip,
          )
          expect(failure).toBeInstanceOf(VerificationFailure)
        })
      ),
      60_000,
    )
  })
})
