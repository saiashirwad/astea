import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import type { ProjectFile } from "../Workspace/index.ts"
import { withProject } from "../test/project-fixture.ts"
import * as Query from "./index.ts"

const ARITY_SOURCE = [
  "export function run(): void {",
  "  zero();",
  "  one(1);",
  "  two(1, 2);",
  "  three(1, 2, 3);",
  "}",
  "function zero(): void {}",
  "function one(a: number): void {}",
  "function two(a: number, b: number): void {}",
  "function three(a: number, b: number, c: number): void {}",
  "",
].join("\n")

const inArity = <A, E, R>(self: Query.Query<A, E, R>): Query.Query<A, E, R> =>
  Query.within(self, "src/arity.ts")

describe("Query.matchesPathGlob", () => {
  const cases: ReadonlyArray<readonly [fileName: string, glob: string, expected: boolean]> = [
    ["src/a.ts", "src/*.ts", true],
    ["src/nested/a.ts", "src/*.ts", false],
    ["src/a.ts", "src/**/*.ts", true],
    ["src/nested/deep/a.ts", "src/**/*.ts", true],
    ["other/a.ts", "src/**/*.ts", false],
    ["a.ts", "**/*.ts", true],
    ["src/lib.ts", "**/lib.ts", true],
    ["src/a+b.ts", "src/a+b.ts", true],
    ["src/ab.ts", "src/a+b.ts", false],
    ["src/a.ts", "src\\*.ts", true],
  ]

  for (const [fileName, glob, expected] of cases) {
    effect(`matchesPathGlob(${JSON.stringify(fileName)}, ${JSON.stringify(glob)})`, () =>
      Effect.sync(() => expect(Query.matchesPathGlob(fileName, glob)).toBe(expected)),
    )
  }
})

describe("Query stream operators", () => {
  effect(
    "collect orders selections by project, file, start, end",
    () =>
      withProject({}, (project) =>
        Effect.gen(function* () {
          const selections = yield* Query.identifiers(project).pipe(Query.collect)
          expect(selections.length).toBeGreaterThan(0)
          const resorted = [...selections].sort(
            (left, right) =>
              left.project.project.id.localeCompare(right.project.project.id) ||
              left.fileName.localeCompare(right.fileName) ||
              left.start - right.start ||
              left.end - right.end,
          )
          expect(selections).toEqual(resorted)
        }),
      ),
    60_000,
  )

  effect(
    "where admits only selections the criterion gives facts, appending its evidence",
    () =>
      withProject(
        { "src/tiny.ts": "export const alpha = 1\nexport const beta = 2\n" },
        (project) => {
          const inTiny = <A, E, R>(self: Query.Query<A, E, R>): Query.Query<A, E, R> =>
            Query.within(self, "src/tiny.ts")
          return Effect.gen(function* () {
            const surviving = yield* Query.identifiers(project).pipe(
              inTiny,
              Query.where(Query.textMatches("alpha")),
              Query.collect,
            )
            expect(surviving.map((selection) => selection.value.text)).toEqual(["alpha"])
            const last = surviving[0]!.evidence.at(-1)!
            expect(last.criterion).toBe("text-matches:alpha")
            expect(last.facts).toEqual({ matchedText: "alpha" })
          })
        },
      ),
    60_000,
  )

  effect(
    "where groups selections into batches of the criterion's batchSize",
    () =>
      withProject({ "src/arity.ts": ARITY_SOURCE }, (project) =>
        Effect.gen(function* () {
          const batchSizes: Array<number> = []
          const batched = Query.Criterion.make({
            id: "record-batch",
            batchSize: 2,
            select: (selections) =>
              Effect.sync(() => {
                batchSizes.push(selections.length)
                return selections.map(() => ({ seen: true }))
              }),
          })
          const surviving = yield* Query.calls(project).pipe(
            inArity,
            Query.where(batched),
            Query.collect,
          )
          // four call expressions: zero(), one(1), two(1, 2), three(1, 2, 3)
          expect(surviving).toHaveLength(4)
          expect(batchSizes).toEqual([2, 2])
          expect(
            surviving.every((selection) => selection.evidence.at(-1)?.criterion === "record-batch"),
          ).toBe(true)
        }),
      ),
    60_000,
  )

  effect(
    "where fails with QueryContractError when a criterion returns a misaligned batch",
    () =>
      withProject({}, (project) =>
        Effect.gen(function* () {
          const misaligned = Query.Criterion.make({
            id: "misaligned",
            select: () => Effect.succeed([]),
          })
          const error = yield* Effect.flip(
            Query.identifiers(project).pipe(Query.where(misaligned), Query.collect),
          )
          expect(error._tag).toBe("QueryContractError")
        }),
      ),
    60_000,
  )

  effect(
    "textMatches admits by substring for strings and full text for regular expressions",
    () =>
      withProject(
        { "src/tiny.ts": "export const alpha = 1\nexport const beta = 2\n" },
        (project) => {
          const inTiny = <A, E, R>(self: Query.Query<A, E, R>): Query.Query<A, E, R> =>
            Query.within(self, "src/tiny.ts")
          return Effect.gen(function* () {
            const substring = yield* Query.identifiers(project).pipe(
              inTiny,
              Query.where(Query.textMatches("alph")),
              Query.collect,
            )
            expect(substring.map((selection) => selection.value.text)).toEqual(["alpha"])

            const anchored = yield* Query.identifiers(project).pipe(
              inTiny,
              Query.where(Query.textMatches(/^beta$/)),
              Query.collect,
            )
            expect(anchored.map((selection) => selection.value.text)).toEqual(["beta"])
          })
        },
      ),
    60_000,
  )

  effect(
    "filter narrows by selection predicate without touching evidence",
    () =>
      withProject({ "src/arity.ts": ARITY_SOURCE }, (project) =>
        Effect.gen(function* () {
          const binary = yield* Query.calls(project).pipe(
            inArity,
            Query.filter((selection) => selection.value.arguments.length === 2),
            Query.collect,
          )
          expect(binary).toHaveLength(1)
          expect(binary[0]!.value.getText()).toBe("two(1, 2)")
        }),
      ),
    60_000,
  )

  effect(
    "withArgCount admits exact counts and min/max ranges",
    () =>
      withProject({ "src/arity.ts": ARITY_SOURCE }, (project) =>
        Effect.gen(function* () {
          const count = (options: number | { readonly min?: number; readonly max?: number }) =>
            Query.calls(project).pipe(inArity, Query.withArgCount(options), Query.collect)

          expect(yield* count(0)).toHaveLength(1)
          expect(yield* count(1)).toHaveLength(1)
          expect(yield* count(2)).toHaveLength(1)
          expect(yield* count(3)).toHaveLength(1)
          expect(yield* count({ min: 2 })).toHaveLength(2)
          expect(yield* count({ max: 1 })).toHaveLength(2)
          expect(yield* count({ min: 1, max: 2 })).toHaveLength(2)
        }),
      ),
    60_000,
  )

  effect(
    "within admits by glob, bare string, regular expression, and exact ProjectFile",
    () =>
      withProject({}, (project) => {
        const countIn = (pattern: string | RegExp | ProjectFile) =>
          Query.identifiers(project).pipe(Query.within(pattern), Query.collect)

        return Effect.gen(function* () {
          const all = yield* countIn("src/**/*.ts")
          const libraryOnly = yield* countIn("library.ts")
          const consumerOnly = yield* countIn("consumer")
          const regExp = yield* countIn(/reexport-consumer/)
          const files = yield* project.files
          const library = files.find((file) => file.path === "src/library.ts")
          expect(library).toBeDefined()

          expect(all.length).toBeGreaterThan(0)
          expect(libraryOnly.length).toBeGreaterThan(0)
          expect(libraryOnly.every((s) => s.fileName.endsWith("library.ts"))).toBe(true)
          expect(consumerOnly.every((s) => s.fileName.includes("consumer"))).toBe(true)
          expect(regExp.every((s) => s.fileName.includes("reexport-consumer"))).toBe(true)
          expect((yield* countIn(library!)).every((s) => s.fileName === "src/library.ts")).toBe(
            true,
          )
        })
      }),
    60_000,
  )
})
