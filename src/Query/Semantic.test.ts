import { describe, effect, expect } from "@effect/vitest"
import { Effect, Option } from "effect"
import { SyntaxKind, type FunctionDeclaration, type NumericLiteral } from "typescript/unstable/ast"
import { isFunctionDeclaration, isNumericLiteral } from "typescript/unstable/ast/is"
import type { ProjectSnapshot } from "../Workspace/index.ts"
import { withProject } from "../test/project-fixture.ts"
import * as Query from "./index.ts"

const SEM_SOURCE = [
  "/** @deprecated use nextThing */",
  "export function oldThing(value: number): number {",
  "  return value + 1",
  "}",
  "",
  "export function nextThing(value: number): number {",
  "  return value + 2",
  "}",
  "",
  "function localHelper(value: number): number {",
  "  return value * 2",
  "}",
  "",
  "oldThing(1);",
  "",
].join("\n")

const inSem = <A, E, R>(self: Query.Query<A, E, R>): Query.Query<A, E, R> =>
  Query.within(self, "src/sem.ts")

const functionNames = (project: ProjectSnapshot) =>
  Query.nodes<FunctionDeclaration>(
    project,
    isFunctionDeclaration,
    SyntaxKind.FunctionDeclaration,
  ).pipe(inSem)

const numericLiterals = (project: ProjectSnapshot) =>
  Query.nodes<NumericLiteral>(project, isNumericLiteral, SyntaxKind.NumericLiteral).pipe(inSem)

describe("Query semantic criteria", () => {
  effect(
    "hasJSDocTag admits nodes carrying the tag, with or without the @ prefix",
    () =>
      withProject({ "src/sem.ts": SEM_SOURCE }, (project) =>
        Effect.gen(function* () {
          const deprecated = yield* functionNames(project).pipe(
            Query.where(Query.hasJSDocTag("deprecated")),
            Query.collect,
          )
          expect(
            deprecated.map((selection) => selection.value.name?.text ?? "<anonymous>"),
          ).toEqual(["oldThing"])

          const prefixed = yield* functionNames(project).pipe(
            Query.where(Query.hasJSDocTag("@deprecated")),
            Query.collect,
          )
          expect(prefixed.map((selection) => selection.value.name?.text ?? "<anonymous>")).toEqual([
            "oldThing",
          ])
        }),
      ),
    60_000,
  )

  effect(
    "isExported admits only declarations with an export modifier",
    () =>
      withProject({ "src/sem.ts": SEM_SOURCE }, (project) =>
        Effect.gen(function* () {
          const exported = yield* functionNames(project).pipe(
            Query.where(Query.isExported()),
            Query.collect,
          )
          expect(
            exported.map((selection) => selection.value.name?.text ?? "<anonymous>").sort(),
          ).toEqual(["nextThing", "oldThing"])
        }),
      ),
    60_000,
  )

  effect(
    "referencesTo finds canonical occurrences of a resolved symbol",
    () =>
      withProject({ "src/sem.ts": SEM_SOURCE }, (project) =>
        Effect.gen(function* () {
          const symbolOption = yield* project.findSymbolNamed("oldThing", {
            within: "src/sem.ts",
          })
          if (Option.isNone(symbolOption)) return expect.unreachable("symbol not found")

          const references = yield* Query.referencesTo(project, symbolOption.value).pipe(
            Query.collect,
          )
          expect(references.map((selection) => selection.value.text)).toEqual([
            "oldThing",
            "oldThing",
          ])
        }),
      ),
    60_000,
  )

  effect(
    "typeOf inspects the computed type of a node",
    () =>
      withProject({ "src/sem.ts": SEM_SOURCE }, (project) =>
        Effect.gen(function* () {
          const parameters = yield* Query.identifiers(project).pipe(
            inSem,
            Query.filter((selection) => selection.value.text === "value"),
            Query.collect,
          )
          expect(parameters.length).toBe(6) // three parameters plus three uses
          const nativeType = yield* Query.typeOf(project, parameters[0]!.value)
          expect(nativeType).toBeDefined()
          const rendered = yield* project.typeToString(nativeType!)
          expect(rendered).toBe("number")
        }),
      ),
    60_000,
  )

  effect(
    "typeAssignableTo admits nodes assignable to an intrinsic type and records the target",
    () =>
      withProject({ "src/sem.ts": SEM_SOURCE }, (project) =>
        Effect.gen(function* () {
          const numbers = yield* numericLiterals(project).pipe(
            Query.where(Query.typeAssignableTo("number")),
            Query.collect,
          )
          // Literal expressions carry literal types ("1", "2"), which are assignable to number.
          expect(new Set(numbers.map((selection) => selection.value.text))).toEqual(
            new Set(["1", "2"]),
          )
          expect(
            numbers.every(
              (selection) => selection.evidence.at(-1)?.facts.assignableTo === "number",
            ),
          ).toBe(true)

          const strings = yield* numericLiterals(project).pipe(
            Query.where(Query.typeAssignableTo("string")),
            Query.collect,
          )
          expect(strings).toEqual([])
        }),
      ),
    60_000,
  )

  effect(
    "typeSatisfies admits nodes whose computed type passes the predicate",
    () =>
      withProject({ "src/sem.ts": SEM_SOURCE }, (project) =>
        Effect.gen(function* () {
          const satisfied = yield* numericLiterals(project).pipe(
            Query.where(
              Query.typeSatisfies("numeric-text", (_type, rendered) =>
                Number.isFinite(Number(rendered)),
              ),
            ),
            Query.collect,
          )
          expect(satisfied.length).toBeGreaterThan(0)
          expect(
            satisfied.every(
              (selection) => selection.evidence.at(-1)?.criterion === "type-satisfies:numeric-text",
            ),
          ).toBe(true)
        }),
      ),
    60_000,
  )
})
