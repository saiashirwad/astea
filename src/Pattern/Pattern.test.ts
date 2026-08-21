import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import type { CallExpression } from "typescript/unstable/ast"
import * as Pattern from "../Pattern/index.ts"
import { Criterion } from "../Query/index.ts"
import * as Query from "../Query/index.ts"
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("declarative transformations API (@effect/vitest)", () => {
  describe("pattern matchers and query algebra", () => {
    effect(
      "matches AST patterns declaratively and extracts typed bindings with evidence",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const targetSymbol = yield* project.symbolNamed("target", {
                  within: "src/library.ts",
                })

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
              }),
            )
          }),
        ),
      60_000,
    )

    effect(
      "evaluates type assignability and type patterns declaratively",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)

                const typedCallPattern = Pattern.callExpression({
                  expression: Pattern.any,
                  arguments: Pattern.tuple([
                    Pattern.bind("arg", Pattern.typed({ assignableTo: "number" })),
                  ]),
                })

                const matches = yield* Query.match(project, typedCallPattern).pipe(Query.collect)
                expect(matches.length).toBeGreaterThan(0)

                const numberArgs = yield* Query.identifiers(project).pipe(
                  Query.where(Query.typeAssignableTo("number")),
                  Query.collect,
                )
                expect(numberArgs.length).toBeGreaterThan(0)

                const firstCall = matches[0]!.value.call
                const callType = yield* Query.typeOf(project, firstCall)
                expect(callType).toBeDefined()
                const typeStr = yield* project.typeToString(callType!)
                expect(typeStr).toContain("number")
              }),
            )
          }),
        ),
      60_000,
    )

    effect(
      "evaluates algebraic criterion combinators (all, any, not)",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
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
              }),
            )
          }),
        ),
      60_000,
    )

    effect(
      "keeps a /g regex name match stable across two calls",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const pattern = Pattern.identifier({ name: /^target$/g })
                const first = yield* Query.match(project, pattern).pipe(Query.collect)
                const second = yield* Query.match(project, pattern).pipe(Query.collect)
                expect(first.length).toBeGreaterThan(0)
                expect(second.length).toBe(first.length)
              }),
            )
          }),
        ),
      60_000,
    )
  })
})
