import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import {
  overlay,
  Criterion,
  Draft,
  Pattern,
  Query,
  Workspace,
  WorkspaceSnapshot,
} from "../api/index.ts"
import {
  isAwaitExpression,
  isCallExpression,
  isFunctionDeclaration,
  isTryStatement,
  isVariableStatement,
} from "typescript/unstable/ast/is"
import { withFixture } from "../test/declarative-fixture.ts"

describe("declarative transformations API (@effect/vitest)", () => {
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
})
