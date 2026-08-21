import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import { withProject } from "../test/project-fixture.ts"
import * as Query from "./index.ts"

const NAMES_SOURCE = [
  "export const alpha = 1",
  "export const beta = 2",
  "const gamma = 3",
  "",
].join("\n")

describe("Query criterion combinators", () => {
  const inNames = <A, E, R>(self: Query.Query<A, E, R>): Query.Query<A, E, R> =>
    Query.within(self, "src/names.ts")

  effect(
    "all admits selections every criterion admits, merging their facts",
    () =>
      withProject({ "src/names.ts": NAMES_SOURCE }, (project) =>
        Effect.gen(function* () {
          const surviving = yield* Query.identifiers(project).pipe(
            inNames,
            Query.where(
              Query.Criterion.all(Query.textMatches(/^alpha$/), Query.textMatches("lph")),
            ),
            Query.collect,
          )
          expect(surviving.map((selection) => selection.value.text)).toEqual(["alpha"])
        }),
      ),
    60_000,
  )

  effect(
    "any admits selections at least one criterion admits and records which one",
    () =>
      withProject({ "src/names.ts": NAMES_SOURCE }, (project) =>
        Effect.gen(function* () {
          const surviving = yield* Query.identifiers(project).pipe(
            inNames,
            Query.where(
              Query.Criterion.any(Query.textMatches(/^alpha$/), Query.textMatches(/^beta$/)),
            ),
            Query.collect,
          )
          expect(surviving.map((selection) => selection.value.text)).toEqual(["alpha", "beta"])
          expect(surviving[0]!.evidence.at(-1)?.facts.criterion).toBe("text-matches:/^alpha$/")
          expect(surviving[1]!.evidence.at(-1)?.facts.criterion).toBe("text-matches:/^beta$/")
        }),
      ),
    60_000,
  )

  effect(
    "not admits selections the criterion rejects and records the negation",
    () =>
      withProject({ "src/names.ts": NAMES_SOURCE }, (project) =>
        Effect.gen(function* () {
          const surviving = yield* Query.identifiers(project).pipe(
            inNames,
            Query.where(Query.Criterion.not(Query.textMatches(/^alpha$/))),
            Query.collect,
          )
          expect(surviving.map((selection) => selection.value.text)).toEqual(["beta", "gamma"])
          expect(surviving[0]!.evidence.at(-1)?.facts.negated).toBe("text-matches:/^alpha$/")
        }),
      ),
    60_000,
  )

  effect(
    "combinators nest: all(any(...), not(...)) intersects union and complement",
    () =>
      withProject({ "src/names.ts": NAMES_SOURCE }, (project) =>
        Effect.gen(function* () {
          const surviving = yield* Query.identifiers(project).pipe(
            inNames,
            Query.where(
              Query.Criterion.all(
                Query.Criterion.any(Query.textMatches(/^alpha$/), Query.textMatches(/^beta$/)),
                Query.Criterion.not(Query.textMatches(/^alpha$/)),
              ),
            ),
            Query.collect,
          )
          expect(surviving.map((selection) => selection.value.text)).toEqual(["beta"])
        }),
      ),
    60_000,
  )
})
