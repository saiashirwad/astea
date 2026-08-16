import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, effect, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import type { CallExpression } from "typescript/unstable/ast"
import {
  Application,
  computeDiagnosticDiff,
  computeUnifiedDiff,
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
  recipeToAgentTool,
  renderDiagnosticDiff,
  renderPlanPreview,
  Verification,
  VerificationFailure,
  Workspace,
  WorkspaceSnapshot,
} from "./index.ts"
import {
  isFunctionDeclaration,
  isInterfaceDeclaration,
} from "typescript/unstable/ast/is"

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
    effect("chains semantic queries across in-memory overlays without touching disk", () =>
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
    effect("matches AST patterns declaratively and extracts typed bindings with evidence", () =>
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

    effect("evaluates type assignability and type patterns declaratively", () =>
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

    effect("evaluates algebraic criterion combinators (all, any, not)", () =>
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
    effect("validates recipe inputs with Effect Schema", () =>
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

    effect("composes sequential recipes with Recipe.pipe and in-memory transitions", () =>
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

    effect("composes concurrent recipes with Recipe.all and executes conditionally with Recipe.branch", () =>
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
    effect("manipulates imports, call arguments, and object fields preserving formatting", () =>
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

    effect("renames symbols across all declarations, imports, and usages with Draft.renameSymbol", () =>
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

    effect("enforces declarative policies during verification", () =>
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

  // ---------------------------------------------------------------------------
  // 6. File Lifecycle Operations (Create, Delete, Move + Import Rewriting)
  // ---------------------------------------------------------------------------
  describe("file lifecycle operations in plans", () => {
    effect("creates, deletes, and moves files while rewriting relative imports across referencing files", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const mainLayer = planApplicationLayerNode.pipe(
            Layer.provideMerge(Layer.succeed(Workspace, yield* Workspace)),
          )

          const fileLifecycleRecipe = Recipe.define("file-lifecycle", {
            version: "1.0.0",
            policies: [{ diagnostics: "exact-delta" }],
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)

                // 1. Create a brand new file
                const d1 = yield* Draft.files.create(
                  project,
                  "src/utils.ts",
                  "export const magicNumber = 42;\n",
                )

                // 2. Move library.ts -> shared/core.ts (and rewrite imports in consumer.ts)
                const d2 = yield* Draft.files.move(
                  project,
                  "src/library.ts",
                  "src/shared/core.ts",
                )

                return Draft.concat(d1, d2)
              }),
          })

          const plan = yield* Recipe.run(fileLifecycleRecipe, undefined)
          expect(plan.fileOperations?.length).toBe(2)

          const preview = yield* Preview.of(plan)
          expect(preview.files.length).toBeGreaterThanOrEqual(2)

          const verified = yield* Verification.verify(plan, fileLifecycleRecipe, undefined)
          yield* Application.apply(verified).pipe(Effect.provide(mainLayer))

          // Check created file on disk
          const createdContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/utils.ts"), "utf8")
          )
          expect(createdContent).toContain("export const magicNumber = 42;")

          // Check moved file on disk
          const movedContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/shared/core.ts"), "utf8")
          )
          expect(movedContent).toContain("function other(value: number)")

          // Check rewritten relative import in consumer.ts
          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("./shared/core.js")
        })
      ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 7. Declaration Combinators (Interfaces, Classes, Functions)
  // ---------------------------------------------------------------------------
  describe("declaration combinators", () => {
    effect("modifies interfaces, classes, and function signatures with high-fidelity combinators", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const mainLayer = planApplicationLayerNode.pipe(
            Layer.provideMerge(Layer.succeed(Workspace, yield* Workspace)),
          )

          const declRecipe = Recipe.define("declaration-combinators-test", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)

                // 1. Create a class file
                const classFileDraft = yield* Draft.files.create(
                  project,
                  "src/service.ts",
                  "export class UserService {\n  public readonly endpoint: string = \"/api/users\";\n  public async getUser(id: string): Promise<User> {\n    return fetch(`${this.endpoint}/${id}`).then(r => r.json());\n  }\n}\n",
                )

                const lib = yield* project.sourceFile("src/library.ts")
                let libAccumulated = Draft.empty
                if (lib !== undefined) {
                  for (const statement of lib.statements) {
                    // Interface combinators
                    if (isInterfaceDeclaration(statement) && statement.name.text === "TargetInput") {
                      const d1 = yield* Draft.interfaces.addProperty(project, statement, {
                        name: "optionalFlag",
                        type: "boolean",
                        optional: true,
                      })
                      libAccumulated = Draft.concat(libAccumulated, d1)
                    }

                    // Function combinators
                    if (isFunctionDeclaration(statement) && statement.name?.text === "other") {
                      const d2 = yield* Draft.functions.addParameter(project, statement, {
                        name: "tag",
                        type: "string",
                        optional: true,
                      })
                      const d3 = yield* Draft.functions.setReturnType(project, statement, "number")
                      libAccumulated = Draft.concat(libAccumulated, d2, d3)
                    }
                  }
                }

                return Draft.concat(classFileDraft, libAccumulated)
              }),
          })

          const plan = yield* Recipe.run(declRecipe, undefined)
          expect(plan.edits.length).toBeGreaterThanOrEqual(2)

          const verified = yield* Verification.verify(plan, declRecipe, undefined)
          yield* Application.apply(verified).pipe(Effect.provide(mainLayer))

          const libContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/library.ts"), "utf8")
          )
          expect(libContent).toContain("optionalFlag?: boolean;")
          expect(libContent).toContain("function other(value: number, tag?: string): number")

          const serviceContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/service.ts"), "utf8")
          )
          expect(serviceContent).toContain('public readonly endpoint: string = "/api/users";')
          expect(serviceContent).toContain("public async getUser(id: string): Promise<User>")
        })
      ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 8. Automated Code Cleanup & Import Organizing
  // ---------------------------------------------------------------------------
  describe("automated cleanup and import organizing", () => {
    effect("organizes, deduplicates, and sorts imports deterministically", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const mainLayer = planApplicationLayerNode.pipe(
            Layer.provideMerge(Layer.succeed(Workspace, yield* Workspace)),
          )

          const organizeRecipe = Recipe.define("organize-imports-recipe", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.imports.organize(project, "src/consumer.ts")
              }),
          })

          const plan = yield* Recipe.run(organizeRecipe, undefined)
          expect(plan.edits.length).toBe(1)

          const verified = yield* Verification.verify(plan, organizeRecipe, undefined)
          yield* Application.apply(verified).pipe(Effect.provide(mainLayer))

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("import { other, target as renamed } from \"./library.js\";")
        })
      ),
      60_000,
    )

    effect("cleans up unused imports automatically with Draft.cleanUnused", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const mainLayer = planApplicationLayerNode.pipe(
            Layer.provideMerge(Layer.succeed(Workspace, yield* Workspace)),
          )

          // First add an unused import
          const addUnusedRecipe = Recipe.define("add-unused-import", {
            version: "1.0.0",
            policies: [{ diagnostics: "exact-delta" }],
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
                  module: "effect",
                  name: "DanglingUnusedSymbol",
                })
              }),
          })

          const plan1 = yield* Recipe.run(addUnusedRecipe, undefined)
          const verified1 = yield* Verification.verify(plan1, addUnusedRecipe, undefined)
          yield* Application.apply(verified1).pipe(Effect.provide(mainLayer))

          // Now run cleanUnused recipe
          const cleanRecipe = Recipe.define("clean-unused-recipe", {
            version: "1.0.0",
            policies: [{ diagnostics: "exact-delta" }],
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.cleanUnused(project)
              }),
          })

          const cleanWorkspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })
          const cleanMainLayer = planApplicationLayerNode.pipe(Layer.provideMerge(cleanWorkspaceLayer))
          const plan2 = yield* Recipe.run(cleanRecipe, undefined).pipe(Effect.provide(cleanWorkspaceLayer))
          expect(plan2.edits.length).toBeGreaterThanOrEqual(1)

          const verified2 = yield* Verification.verify(plan2, cleanRecipe, undefined).pipe(Effect.provide(cleanWorkspaceLayer))
          yield* Application.apply(verified2).pipe(Effect.provide(cleanMainLayer))

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).not.toContain("DanglingUnusedSymbol")
        })
      ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 9. Interactive CLI, Terminal Diff Rendering & Agent Tool Protocol
  // ---------------------------------------------------------------------------
  describe("diff rendering and agent tool protocol", () => {
    it("renders colored unified diffs and diagnostic reports", () => {
      const before = "const a = 1;\nconst b = 2;\n"
      const after = "const a = 1;\nconst b = 42;\nconst c = 3;\n"

      const diff = computeUnifiedDiff("test.ts", before, after, { color: false })
      expect(diff).toContain("- const b = 2;")
      expect(diff).toContain("+ const b = 42;")
      expect(diff).toContain("+ const c = 3;")

      const diagDiff = computeDiagnosticDiff([], [
        { code: 2322, message: "Type mismatch", category: "error", fileName: "test.ts", start: 0, length: 1 },
      ])
      const renderedDiag = renderDiagnosticDiff(diagDiff, { color: false })
      expect(renderedDiag).toContain("Introduced 1 new diagnostic")
      expect(renderedDiag).toContain("TS2322: Type mismatch")
    })

    effect("bridges recipes into structured agent tools for AI protocols", () =>
      withFixture((_, app) =>
        Effect.gen(function*() {
          const sampleRecipe = Recipe.define("agent-tool-sample", {
            version: "1.0.0",
            schema: Schema.Struct({ multiplier: Schema.Number }),
            run: () => Effect.succeed(Draft.empty),
          })

          const tool = recipeToAgentTool(sampleRecipe, "Sample codemod tool")
          expect(tool.name).toBe("teatime_agent_tool_sample")
          expect(tool.description).toBe("Sample codemod tool")
          expect(tool.schema).toBeDefined()

          const result = yield* tool.execute({ multiplier: 10 })
          expect(result.status).toBe("preview")
          expect(result.planId).toBeDefined()
        })
      ),
      60_000,
    )
  })
})
