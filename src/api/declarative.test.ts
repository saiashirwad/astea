import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
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
  Verification,
  VerificationFailure,
  Workspace,
  WorkspaceSnapshot,
} from "./index.ts"
import {
  isAwaitExpression,
  isCallExpression,
  isFunctionDeclaration,
  isInterfaceDeclaration,
  isTryStatement,
  isVariableStatement,
} from "typescript/unstable/ast/is"

const fixtureSource = fileURLToPath(new URL("../../fixtures/recipe/", import.meta.url))

const withFixture = <A, E, R>(
  use: (root: string, app: ConfiguredProject) => Effect.Effect<A, E, R>,
): Effect.Effect<A, unknown, Exclude<R, Workspace>> =>
  Effect.acquireUseRelease(
    Effect.tryPromise(async () => {
      const root = await Fs.mkdtemp("/tmp/safemods-decl-")
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
  // 3. Relational AST Combinators (inside, has, precedes, follows)
  // ---------------------------------------------------------------------------
  describe("relational AST combinators", () => {
    effect("Query.inside matches nodes nested inside ancestor patterns and handles boundary options", () =>
      withFixture((_, app) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot({}, Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)
            const consumerFile = yield* project.sourceFile("src/consumer.ts")
            expect(consumerFile).toBeDefined()

            const code = `
              export async function userHandler() {
                const list = [1, 2, 3];
                for (const item of list) {
                  await processItem(item);
                }
              }

              export function normalFunction() {
                function innerHelper() {
                  console.log("nested");
                }
                for (let i = 0; i < 10; i++) {
                  function callbackInsideLoop() {
                    console.log("in-callback");
                  }
                  console.log("direct-in-loop");
                }
              }
            `
            const draft = yield* Draft.replace(project, consumerFile!, code)
            yield* overlay(draft, Effect.gen(function*() {
              const overlaySnapshot = yield* WorkspaceSnapshot
              const overlayProject = yield* overlaySnapshot.project(app)

              // 1. Match await expressions inside loops
              const awaitsInLoops = yield* Query.nodes(overlayProject, isAwaitExpression).pipe(
                Query.inside(Pattern.loop()),
                Query.collect,
              )
              expect(awaitsInLoops.length).toBe(1)
              expect(awaitsInLoops[0]!.evidence.some((e) => e.criterion.startsWith("inside"))).toBe(true)

              // 2. Match await expressions inside handlers matching naming pattern
              const awaitsInHandlers = yield* Query.nodes(overlayProject, isAwaitExpression).pipe(
                Query.inside(Pattern.functionDeclaration({ name: /Handler$/ })),
                Query.collect,
              )
              expect(awaitsInHandlers.length).toBe(1)

              // 3. Boundary test: "in-callback" is inside a function inside a loop
              // With stopBy: 'boundary', searching inside loop stops at callbackInsideLoop boundary (no match)
              const logsInLoopWithBoundary = yield* Query.calls(overlayProject).pipe(
                Query.within("src/consumer.ts"),
                Query.where(Query.textMatches("in-callback")),
                Query.inside(Pattern.loop(), { stopBy: "boundary" }),
                Query.collect,
              )
              expect(logsInLoopWithBoundary.length).toBe(0)

              // With stopBy: 'root' (default), it traverses past function boundary to find outer loop
              const logsInLoopWithRoot = yield* Query.calls(overlayProject).pipe(
                Query.within("src/consumer.ts"),
                Query.where(Query.textMatches("in-callback")),
                Query.inside(Pattern.loop(), { stopBy: "root" }),
                Query.collect,
              )
              expect(logsInLoopWithRoot.length).toBe(1)
            }))
          }))
        })
      ),
      60_000,
    )

    effect("Query.has matches nodes containing descendant patterns, symbols, and respects boundaries", () =>
      withFixture((_, app) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot({}, Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)
            const consumerFile = yield* project.sourceFile("src/consumer.ts")
            expect(consumerFile).toBeDefined()
            const code = `
              import { target } from "./library.js";

              export function tryWithTarget() {
                try {
                  target(1);
                } catch (err) {
                  throw err;
                }
              }

              export function tryWithoutTarget() {
                try {
                  console.log("no target");
                } catch (err) {
                  throw err;
                }
              }

              export function outerFunction() {
                function innerWithTarget() {
                  target(2);
                }
              }
            `
            const draft = yield* Draft.replace(project, consumerFile!, code)
            yield* overlay(draft, Effect.gen(function*() {
              const overlaySnapshot = yield* WorkspaceSnapshot
              const overlayProject = yield* overlaySnapshot.project(app)
              const targetSymbol = yield* overlayProject.symbolNamed("target", { within: "src/library.ts" })

              // 1. Find try-catch statements that have target calls matching symbol criterion
              const tryWithTarget = yield* Query.nodes(overlayProject, isTryStatement).pipe(
                Query.has(Query.resolvesTo(targetSymbol, { location: (n) => isCallExpression(n) ? n.expression : n })),
                Query.collect,
              )
              expect(tryWithTarget.length).toBe(1)
              expect(tryWithTarget[0]!.evidence.some((e) => e.criterion.startsWith("has"))).toBe(true)

              // 2. Test stopBy: 'boundary' on outerFunction
              // With boundary: outerFunction does NOT match because target is inside nested innerWithTarget
              const outerBoundary = yield* Query.nodes(overlayProject, isFunctionDeclaration).pipe(
                Query.where(Query.textMatches("outerFunction")),
                Query.has(Pattern.identifier({ name: "target" }), { stopBy: "boundary" }),
                Query.collect,
              )
              expect(outerBoundary.length).toBe(0)

              // Without boundary / stopBy: 'root': outerFunction matches
              const outerRoot = yield* Query.nodes(overlayProject, isFunctionDeclaration).pipe(
                Query.where(Query.textMatches("outerFunction")),
                Query.has(Pattern.identifier({ name: "target" }), { stopBy: "root" }),
                Query.collect,
              )
              expect(outerRoot.length).toBe(1)
            }))
          }))
        })
      ),
      60_000,
    )

    effect("Query.precedes and Query.follows evaluate sibling relationships with immediate and non-immediate matching", () =>
      withFixture((_, app) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot({}, Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)
            const consumerFile = yield* project.sourceFile("src/consumer.ts")
            expect(consumerFile).toBeDefined()

            const code = `
              export function workflow() {
                const initialized = true;
                const intermediate = 42;
                doAction();
                cleanup();
              }
            `
            const draft = yield* Draft.replace(project, consumerFile!, code)
            yield* overlay(draft, Effect.gen(function*() {
              const overlaySnapshot = yield* WorkspaceSnapshot
              const overlayProject = yield* overlaySnapshot.project(app)

              // 1. doAction follows initialization (non-immediate: true since intermediate is between them)
              const callsFollowingInit = yield* Query.calls(overlayProject).pipe(
                Query.where(Query.textMatches("doAction")),
                Query.follows(Pattern.variableStatement({ name: "initialized" })),
                Query.collect,
              )
              expect(callsFollowingInit.length).toBe(1)

              // 2. doAction does NOT immediately follow initialization
              const callsImmediatelyFollowingInit = yield* Query.calls(overlayProject).pipe(
                Query.where(Query.textMatches("doAction")),
                Query.follows(Pattern.variableStatement({ name: "initialized" }), { immediately: true }),
                Query.collect,
              )
              expect(callsImmediatelyFollowingInit.length).toBe(0)

              // 3. doAction immediately follows intermediate variable
              const callsImmediatelyFollowingInter = yield* Query.calls(overlayProject).pipe(
                Query.where(Query.textMatches("doAction")),
                Query.follows(Pattern.variableStatement({ name: "intermediate" }), { immediately: true }),
                Query.collect,
              )
              expect(callsImmediatelyFollowingInter.length).toBe(1)

              // 4. doAction immediately precedes cleanup
              const callsImmediatelyPrecedingCleanup = yield* Query.calls(overlayProject).pipe(
                Query.where(Query.textMatches("doAction")),
                Query.precedes(Pattern.callExpression({ expression: Pattern.identifier({ name: "cleanup" }) }), { immediately: true }),
                Query.collect,
              )
              expect(callsImmediatelyPrecedingCleanup.length).toBe(1)

              // 5. initialization precedes cleanup (non-immediate)
              const initPrecedingCleanup = yield* Query.nodes(overlayProject, isVariableStatement).pipe(
                Query.where(Query.textMatches("initialized")),
                Query.preceding(Pattern.callExpression({ expression: Pattern.identifier({ name: "cleanup" }) })),
                Query.collect,
              )
              expect(initPrecedingCleanup.length).toBe(1)

              // 6. cleanup follows initialization using Query.following alias
              const cleanupFollowingInit = yield* Query.calls(overlayProject).pipe(
                Query.where(Query.textMatches("cleanup")),
                Query.following(Pattern.variableStatement({ name: "initialized" })),
                Query.collect,
              )
              expect(cleanupFollowingInit.length).toBe(1)
            }))
          }))
        })
      ),
      60_000,
    )

    effect("composes relational combinators with algebraic Criterion algebra (all, any, not)", () =>
      withFixture((_, app) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot({}, Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)
            const consumerFile = yield* project.sourceFile("src/consumer.ts")
            expect(consumerFile).toBeDefined()

            const code = `
              export class Service {
                public methodA() {
                  console.log("inside-class-not-loop");
                }
                public methodB() {
                  for (let i = 0; i < 5; i++) {
                    console.log("inside-class-and-loop");
                  }
                }
              }
              export function standalone() {
                for (let i = 0; i < 5; i++) {
                  console.log("outside-class-in-loop");
                }
              }
            `
            const draft = yield* Draft.replace(project, consumerFile!, code)
            yield* overlay(draft, Effect.gen(function*() {
              const overlaySnapshot = yield* WorkspaceSnapshot
              const overlayProject = yield* overlaySnapshot.project(app)

              // Inside class AND inside loop
              const inClassAndLoop = yield* Query.calls(overlayProject).pipe(
                Query.where(
                  Criterion.all(
                    Criterion.inside(Pattern.classDeclaration({ name: "Service" })),
                    Criterion.inside(Pattern.loop()),
                  ),
                ),
                Query.collect,
              )
              expect(inClassAndLoop.length).toBe(1)
              expect(inClassAndLoop[0]!.value.getText(inClassAndLoop[0]!.value.getSourceFile())).toContain("inside-class-and-loop")

              // Inside class BUT NOT inside loop
              const inClassNotLoop = yield* Query.calls(overlayProject).pipe(
                Query.where(
                  Criterion.all(
                    Criterion.inside(Pattern.classDeclaration({ name: "Service" })),
                    Criterion.not(Criterion.inside(Pattern.loop())),
                  ),
                ),
                Query.collect,
              )
              expect(inClassNotLoop.length).toBe(1)
              expect(inClassNotLoop[0]!.value.getText(inClassNotLoop[0]!.value.getSourceFile())).toContain("inside-class-not-loop")

              // Inside class OR inside loop
              const inClassOrLoop = yield* Query.calls(overlayProject).pipe(
                Query.where(
                  Criterion.any(
                    Criterion.inside(Pattern.classDeclaration({ name: "Service" })),
                    Criterion.inside(Pattern.loop()),
                  ),
                ),
                Query.collect,
              )
              expect(inClassOrLoop.length).toBe(3)
            }))
          }))
        })
      ),
      60_000,
    )

    effect("evaluates declarative pattern matchers across control flow and declaration types", () =>
      withFixture((_, app) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot({}, Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)
            const consumerFile = yield* project.sourceFile("src/consumer.ts")
            expect(consumerFile).toBeDefined()

            const code = `
              export class Controller {
                public handle() {
                  if (true) {
                    return 42;
                  } else {
                    return 0;
                  }
                }
              }

              while (false) {
                doWork();
              }

              do {
                doOnce();
              } while (false);

              for (let i = 0; i < 1; i++) {
                const x = 1;
              }

              for (const elem of [1]) {
                const y = elem;
              }

              for (const key in { a: 1 }) {
                const z = key;
              }
            `
            const draft = yield* Draft.replace(project, consumerFile!, code)
            yield* overlay(draft, Effect.gen(function*() {
              const overlaySnapshot = yield* WorkspaceSnapshot
              const overlayProject = yield* overlaySnapshot.project(app)

              // 1. Class pattern
              const classes = yield* Query.match(overlayProject, Pattern.classDeclaration({ name: "Controller", exported: true })).pipe(
                Query.within("src/consumer.ts"),
                Query.collect,
              )
              expect(classes.length).toBe(1)

              // 2. If-statement pattern with else branch
              const ifWithElse = yield* Query.match(overlayProject, Pattern.ifStatement({ hasElse: true })).pipe(
                Query.within("src/consumer.ts"),
                Query.collect,
              )
              expect(ifWithElse.length).toBe(1)

              // 3. Return statement pattern
              const returns = yield* Query.match(overlayProject, Pattern.returnStatement()).pipe(
                Query.within("src/consumer.ts"),
                Query.collect,
              )
              expect(returns.length).toBe(2)

              // 4. While statement pattern
              const whiles = yield* Query.match(overlayProject, Pattern.whileStatement()).pipe(
                Query.within("src/consumer.ts"),
                Query.collect,
              )
              expect(whiles.length).toBe(1)

              // 5. Do statement pattern
              const dos = yield* Query.match(overlayProject, Pattern.doStatement()).pipe(
                Query.within("src/consumer.ts"),
                Query.collect,
              )
              expect(dos.length).toBe(1)

              // 6. For statement pattern
              const fors = yield* Query.match(overlayProject, Pattern.forStatement()).pipe(
                Query.within("src/consumer.ts"),
                Query.collect,
              )
              expect(fors.length).toBe(1)

              // 7. For-of statement pattern
              const forOfs = yield* Query.match(overlayProject, Pattern.forOfStatement()).pipe(
                Query.within("src/consumer.ts"),
                Query.collect,
              )
              expect(forOfs.length).toBe(1)

              // 8. For-in statement pattern
              const forIns = yield* Query.match(overlayProject, Pattern.forInStatement()).pipe(
                Query.within("src/consumer.ts"),
                Query.collect,
              )
              expect(forIns.length).toBe(1)

              // 9. Generic loop pattern matching all loops
              const allLoops = yield* Query.match(overlayProject, Pattern.loop()).pipe(
                Query.within("src/consumer.ts"),
                Query.collect,
              )
              expect(allLoops.length).toBe(5)
            }))
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
      withFixture((_, _app) =>
        Effect.gen(function*() {
          const schemaRecipe = Recipe.define("schema-recipe", {
            version: "1.0.0",
            schema: Schema.Struct({
              propertyName: Schema.NonEmptyString,
              multiplier: Schema.Finite,
            }),
            run: (input) =>
              Effect.sync(() => {
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

    effect("composes sequential recipes on the SAME file via Recipe.pipe without edit corruption", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const step1 = Recipe.define("step1-add-import", {
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

          const step2 = Recipe.define("step2-wrap-arg", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const target = yield* project.symbolNamed("target", { within: "src/library.ts" })
                const calls = yield* Query.calls(project).pipe(
                  Query.within("src/consumer.ts"),
                  Query.where(Query.resolvesTo(target, { location: (c) => c.expression })),
                  Query.collect,
                )
                return yield* Draft.replaceEach(calls, ({ project: p, value: call }) =>
                  Draft.wrapArgument(p, call, 0, (arg) => `{ value: ${arg} }`)
                )
              }),
          })

          const piped = Recipe.pipe(step1, step2)
          const plan = yield* Recipe.run(piped, undefined)
          const verified = yield* Verification.verify(plan, piped, undefined)
          yield* Application.apply(verified).pipe(
            Effect.provide(planApplicationLayerNode),
          )

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("TargetInput")
          expect(consumerContent).toContain("renamed(/* keep this comment */ { value: 1 })")
        })
      ),
      60_000,
    )

    effect("Draft.renameSymbolNamed provides idempotent symbol renaming by name", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const renameRecipe = Recipe.define("rename-by-name", {
            version: "1.0.0",
            policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.renameSymbolNamed(project, "target", "newTarget", {
                  within: "src/library.ts",
                })
              }),
          })

          const plan = yield* Recipe.run(renameRecipe, undefined)
          const verified = yield* Verification.verify(plan, renameRecipe, undefined)
          yield* Application.apply(verified).pipe(
            Effect.provide(planApplicationLayerNode),
          )

          const libContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/library.ts"), "utf8")
          )
          expect(libContent).toContain("export function newTarget")
        })
      ),
      60_000,
    )

    effect("supports validated ProjectFile handles with fail-fast lookup and scoped operations", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const fileRecipe = Recipe.define("use-project-file", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)

                // 1. Validated file lookup (fails fast with FileNotFound if missing)
                const consumerFile = yield* project.file("src/consumer.ts")
                expect(consumerFile.path).toBe("src/consumer.ts")

                // 2. Optional file lookup
                const maybeFile = yield* project.findFile("src/nonexistent.ts")
                expect(maybeFile._tag).toBe("None")

                // 3. Scoped symbol lookup from file
                const libraryFile = yield* project.file("src/library.ts")
                const targetSymbol = yield* libraryFile.symbolNamed("target")
                expect(targetSymbol.name).toBe("target")

                // 4. Scoped query directly on ProjectFile
                const callsInConsumer = yield* Query.calls(consumerFile).pipe(
                  Query.where(Query.resolvesTo(targetSymbol, { location: (c) => c.expression })),
                  Query.collect,
                )
                expect(callsInConsumer.length).toBe(1)

                // 5. Scoped import addition on ProjectFile
                const importDraft = yield* Draft.imports.addNamed(consumerFile, {
                  module: "./library.js",
                  name: "TargetInput",
                })

                // 6. Scoped argument replacement
                const replaceDraft = yield* Draft.replaceEach(callsInConsumer, ({ project: p, value: call }) =>
                  Draft.wrapArgument(p, call, 0, (arg) => `{ value: ${arg} }`)
                )

                return Draft.concat(importDraft, replaceDraft)
              }),
          })

          const plan = yield* Recipe.run(fileRecipe, undefined)
          const verified = yield* Verification.verify(plan, fileRecipe, undefined)
          yield* Application.apply(verified).pipe(
            Effect.provide(planApplicationLayerNode),
          )

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("TargetInput")
          expect(consumerContent).toContain("renamed(/* keep this comment */ { value: 1 })")
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
      withFixture((_, _app) =>
        Effect.gen(function*() {
          const sampleRecipe = Recipe.define("agent-tool-sample", {
            version: "1.0.0",
            schema: Schema.Struct({ multiplier: Schema.Finite }),
            run: () => Effect.succeed(Draft.empty),
          })

          const tool = recipeToAgentTool(sampleRecipe, "Sample codemod tool")
          expect(tool.name).toBe("safemods_agent_tool_sample")
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
