import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import * as Draft from "../Draft/index.ts"
import * as Overlay from "../Overlay/index.ts"
import * as Pattern from "../Pattern/index.ts"
import { Criterion } from "../Query/index.ts"
import * as Query from "../Query/index.ts"
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
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
    effect(
      "Query.inside matches nodes nested inside ancestor patterns and handles boundary options",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
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
                yield* Overlay.run(
                  draft,
                  Effect.gen(function* () {
                    const overlaySnapshot = yield* WorkspaceSnapshot
                    const overlayProject = yield* overlaySnapshot.project(app)

                    const awaitsInLoops = yield* Query.nodes(
                      overlayProject,
                      isAwaitExpression,
                    ).pipe(Query.inside(Pattern.loop()), Query.collect)
                    expect(awaitsInLoops.length).toBe(1)
                    expect(
                      awaitsInLoops[0]!.evidence.some((e) => e.criterion.startsWith("inside")),
                    ).toBe(true)

                    const awaitsInHandlers = yield* Query.nodes(
                      overlayProject,
                      isAwaitExpression,
                    ).pipe(
                      Query.inside(Pattern.functionDeclaration({ name: /Handler$/ })),
                      Query.collect,
                    )
                    expect(awaitsInHandlers.length).toBe(1)

                    const logsInLoopWithBoundary = yield* Query.calls(overlayProject).pipe(
                      Query.within("src/consumer.ts"),
                      Query.where(Query.textMatches("in-callback")),
                      Query.inside(Pattern.loop(), { stopBy: "boundary" }),
                      Query.collect,
                    )
                    expect(logsInLoopWithBoundary.length).toBe(0)

                    const logsInLoopWithRoot = yield* Query.calls(overlayProject).pipe(
                      Query.within("src/consumer.ts"),
                      Query.where(Query.textMatches("in-callback")),
                      Query.inside(Pattern.loop(), { stopBy: "root" }),
                      Query.collect,
                    )
                    expect(logsInLoopWithRoot.length).toBe(1)
                  }),
                )
              }),
            )
          }),
        ),
      60_000,
    )

    effect(
      "Query.has matches nodes containing descendant patterns, symbols, and respects boundaries",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
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
                yield* Overlay.run(
                  draft,
                  Effect.gen(function* () {
                    const overlaySnapshot = yield* WorkspaceSnapshot
                    const overlayProject = yield* overlaySnapshot.project(app)
                    const targetSymbol = yield* overlayProject.symbolNamed("target", {
                      within: "src/library.ts",
                    })

                    const tryWithTarget = yield* Query.nodes(overlayProject, isTryStatement).pipe(
                      Query.has(
                        Query.resolvesTo(targetSymbol, {
                          location: (n) => (isCallExpression(n) ? n.expression : n),
                        }),
                      ),
                      Query.collect,
                    )
                    expect(tryWithTarget.length).toBe(1)
                    expect(
                      tryWithTarget[0]!.evidence.some((e) => e.criterion.startsWith("has")),
                    ).toBe(true)

                    const outerBoundary = yield* Query.nodes(
                      overlayProject,
                      isFunctionDeclaration,
                    ).pipe(
                      Query.where(Query.textMatches("outerFunction")),
                      Query.has(Pattern.identifier({ name: "target" }), { stopBy: "boundary" }),
                      Query.collect,
                    )
                    expect(outerBoundary.length).toBe(0)

                    const outerRoot = yield* Query.nodes(
                      overlayProject,
                      isFunctionDeclaration,
                    ).pipe(
                      Query.where(Query.textMatches("outerFunction")),
                      Query.has(Pattern.identifier({ name: "target" }), { stopBy: "root" }),
                      Query.collect,
                    )
                    expect(outerRoot.length).toBe(1)
                  }),
                )
              }),
            )
          }),
        ),
      60_000,
    )

    effect(
      "Query.precedes and Query.follows evaluate sibling relationships with immediate and non-immediate matching",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
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
                yield* Overlay.run(
                  draft,
                  Effect.gen(function* () {
                    const overlaySnapshot = yield* WorkspaceSnapshot
                    const overlayProject = yield* overlaySnapshot.project(app)

                    const callsFollowingInit = yield* Query.calls(overlayProject).pipe(
                      Query.where(Query.textMatches("doAction")),
                      Query.follows(Pattern.variableStatement({ name: "initialized" })),
                      Query.collect,
                    )
                    expect(callsFollowingInit.length).toBe(1)

                    const callsImmediatelyFollowingInit = yield* Query.calls(overlayProject).pipe(
                      Query.where(Query.textMatches("doAction")),
                      Query.follows(Pattern.variableStatement({ name: "initialized" }), {
                        immediately: true,
                      }),
                      Query.collect,
                    )
                    expect(callsImmediatelyFollowingInit.length).toBe(0)

                    const callsImmediatelyFollowingInter = yield* Query.calls(overlayProject).pipe(
                      Query.where(Query.textMatches("doAction")),
                      Query.follows(Pattern.variableStatement({ name: "intermediate" }), {
                        immediately: true,
                      }),
                      Query.collect,
                    )
                    expect(callsImmediatelyFollowingInter.length).toBe(1)

                    const callsImmediatelyPrecedingCleanup = yield* Query.calls(
                      overlayProject,
                    ).pipe(
                      Query.where(Query.textMatches("doAction")),
                      Query.precedes(
                        Pattern.callExpression({
                          expression: Pattern.identifier({ name: "cleanup" }),
                        }),
                        { immediately: true },
                      ),
                      Query.collect,
                    )
                    expect(callsImmediatelyPrecedingCleanup.length).toBe(1)

                    const initPrecedingCleanup = yield* Query.nodes(
                      overlayProject,
                      isVariableStatement,
                    ).pipe(
                      Query.where(Query.textMatches("initialized")),
                      Query.precedes(
                        Pattern.callExpression({
                          expression: Pattern.identifier({ name: "cleanup" }),
                        }),
                      ),
                      Query.collect,
                    )
                    expect(initPrecedingCleanup.length).toBe(1)

                    const cleanupFollowingInit = yield* Query.calls(overlayProject).pipe(
                      Query.where(Query.textMatches("cleanup")),
                      Query.follows(Pattern.variableStatement({ name: "initialized" })),
                      Query.collect,
                    )
                    expect(cleanupFollowingInit.length).toBe(1)
                  }),
                )
              }),
            )
          }),
        ),
      60_000,
    )

    effect(
      "composes relational combinators with algebraic Criterion algebra (all, any, not)",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
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
                yield* Overlay.run(
                  draft,
                  Effect.gen(function* () {
                    const overlaySnapshot = yield* WorkspaceSnapshot
                    const overlayProject = yield* overlaySnapshot.project(app)

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
                    expect(
                      inClassAndLoop[0]!.value.getText(inClassAndLoop[0]!.value.getSourceFile()),
                    ).toContain("inside-class-and-loop")

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
                    expect(
                      inClassNotLoop[0]!.value.getText(inClassNotLoop[0]!.value.getSourceFile()),
                    ).toContain("inside-class-not-loop")

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
                  }),
                )
              }),
            )
          }),
        ),
      60_000,
    )

    effect(
      "evaluates declarative pattern matchers across control flow and declaration types",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
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
                yield* Overlay.run(
                  draft,
                  Effect.gen(function* () {
                    const overlaySnapshot = yield* WorkspaceSnapshot
                    const overlayProject = yield* overlaySnapshot.project(app)

                    const classes = yield* Query.match(
                      overlayProject,
                      Pattern.classDeclaration({ name: "Controller", exported: true }),
                    ).pipe(Query.within("src/consumer.ts"), Query.collect)
                    expect(classes.length).toBe(1)

                    const ifWithElse = yield* Query.match(
                      overlayProject,
                      Pattern.ifStatement({ hasElse: true }),
                    ).pipe(Query.within("src/consumer.ts"), Query.collect)
                    expect(ifWithElse.length).toBe(1)

                    const returns = yield* Query.match(
                      overlayProject,
                      Pattern.returnStatement(),
                    ).pipe(Query.within("src/consumer.ts"), Query.collect)
                    expect(returns.length).toBe(2)

                    const whiles = yield* Query.match(
                      overlayProject,
                      Pattern.whileStatement(),
                    ).pipe(Query.within("src/consumer.ts"), Query.collect)
                    expect(whiles.length).toBe(1)

                    const dos = yield* Query.match(overlayProject, Pattern.doStatement()).pipe(
                      Query.within("src/consumer.ts"),
                      Query.collect,
                    )
                    expect(dos.length).toBe(1)

                    const fors = yield* Query.match(overlayProject, Pattern.forStatement()).pipe(
                      Query.within("src/consumer.ts"),
                      Query.collect,
                    )
                    expect(fors.length).toBe(1)

                    const forOfs = yield* Query.match(
                      overlayProject,
                      Pattern.forOfStatement(),
                    ).pipe(Query.within("src/consumer.ts"), Query.collect)
                    expect(forOfs.length).toBe(1)

                    const forIns = yield* Query.match(
                      overlayProject,
                      Pattern.forInStatement(),
                    ).pipe(Query.within("src/consumer.ts"), Query.collect)
                    expect(forIns.length).toBe(1)

                    const allLoops = yield* Query.match(overlayProject, Pattern.loop()).pipe(
                      Query.within("src/consumer.ts"),
                      Query.collect,
                    )
                    expect(allLoops.length).toBe(5)
                  }),
                )
              }),
            )
          }),
        ),
      60_000,
    )

    effect(
      "supports data-first and data-last invocation for generic query operators",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const calls = Query.calls(project)

                const dataFirstWhere = yield* Query.collect(
                  Query.where(calls, Query.textMatches("renamed")),
                )
                const dataLastWhere = yield* calls.pipe(
                  Query.where(Query.textMatches("renamed")),
                  Query.collect,
                )
                expect(dataFirstWhere.length).toBe(dataLastWhere.length)

                const dataFirstFilter = yield* Query.collect(
                  Query.filter(calls, (selection) => selection.fileName.endsWith("consumer.ts")),
                )
                const dataLastFilter = yield* calls.pipe(
                  Query.filter((selection) => selection.fileName.endsWith("consumer.ts")),
                  Query.collect,
                )
                expect(dataFirstFilter.length).toBe(dataLastFilter.length)

                const dataFirstWithin = yield* Query.collect(Query.within(calls, "src/consumer.ts"))
                const dataLastWithin = yield* calls.pipe(
                  Query.within("src/consumer.ts"),
                  Query.collect,
                )
                expect(dataFirstWithin.length).toBe(dataLastWithin.length)

                const dataFirstArgCount = yield* Query.collect(Query.withArgCount(calls, 1))
                const dataLastArgCount = yield* calls.pipe(Query.withArgCount(1), Query.collect)
                expect(dataFirstArgCount.length).toBe(dataLastArgCount.length)
              }),
            )
          }),
        ),
      60_000,
    )
  })
})
