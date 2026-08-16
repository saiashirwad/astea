/** Core Query domain types and criterion combinators. */
import { Data, Effect, type Stream } from "effect"
import type { EvidenceFact, QueryEvidence } from "../Evidence/Model.ts"
import type { ProjectFile, ProjectSnapshot } from "../Workspace/index.ts"

export type { EvidenceFact, QueryEvidence } from "../Evidence/Model.ts"
export type ProjectScope = ProjectSnapshot | ProjectFile | ReadonlyArray<ProjectFile>

export interface TargetFileScope {
  readonly project: ProjectSnapshot
  readonly fileName: string
}

/**
 * An occurrence admitted by a query: the snapshot-scoped native value, its
 * durable project-relative location, the Project Snapshot it belongs to, and
 * the evidence explaining why it qualified.
 */
export interface Selection<A> {
  readonly value: A
  readonly project: ProjectSnapshot
  /** Project-relative, case-preserving path. Safe for durable evidence. */
  readonly fileName: string
  readonly start: number
  readonly end: number
  readonly evidence: ReadonlyArray<QueryEvidence>
}

export type Query<A, E = never, R = never> = Stream.Stream<Selection<A>, E, R>

export class QueryContractError extends Data.TaggedError("QueryContractError")<{
  readonly criterion: string
  readonly expected: number
  readonly actual: number
}> {}

/**
 * A batched semantic criterion. `select` receives a batch of Selections and
 * returns aligned optional evidence facts: `undefined` rejects the candidate,
 * facts admit it and are recorded as Query Evidence. A length mismatch is a
 * QueryContractError.
 */
export interface Criterion<A, E = never, R = never> {
  readonly id: string
  readonly batchSize?: number
  readonly select: (
    selections: ReadonlyArray<Selection<A>>,
  ) => Effect.Effect<ReadonlyArray<Readonly<Record<string, EvidenceFact>> | undefined>, E, R>
}

const criterionMake = <A, E = never, R = never>(options: {
  readonly id: string
  readonly batchSize?: number
  readonly select: (
    selections: ReadonlyArray<Selection<A>>,
  ) => Effect.Effect<ReadonlyArray<Readonly<Record<string, EvidenceFact>> | undefined>, E, R>
}): Criterion<A, E, R> => options

type PredicateOutcome = boolean | Readonly<Record<string, EvidenceFact>> | undefined

const criterionPredicate = <A>(
  id: string,
  predicateFn: (selection: Selection<A>) => PredicateOutcome,
): Criterion<A> => ({
  id,
  select: (selections) =>
    Effect.sync(() =>
      selections.map((selection) => {
        const res = predicateFn(selection)
        if (res === true) return { matched: true }
        if (res === false || res === undefined) return undefined
        return res
      })
    ),
})

/** Combinator that admits candidates only when all given criteria admit them. */
const criterionAll = <A, E, R>(
  ...criteria: ReadonlyArray<Criterion<A, E, R>>
): Criterion<A, E, R> => ({
  id: `all(${criteria.map((c) => c.id).join(", ")})`,
  select: (selections) =>
    Effect.gen(function*() {
      let accumulated: Array<Record<string, EvidenceFact> | undefined> = selections.map(() => ({}))
      for (const criterion of criteria) {
        const batchResults = yield* criterion.select(selections)
        accumulated = accumulated.map((curr, idx) => {
          if (curr === undefined) return undefined
          const next = batchResults[idx]
          if (next === undefined) return undefined
          return { ...curr, ...next }
        })
      }
      return accumulated
    }),
})

/** Combinator that admits candidates when at least one criterion admits them. */
const criterionAny = <A, E, R>(
  ...criteria: ReadonlyArray<Criterion<A, E, R>>
): Criterion<A, E, R> => ({
  id: `any(${criteria.map((c) => c.id).join(", ")})`,
  select: (selections) =>
    Effect.gen(function*() {
      const results: Array<Record<string, EvidenceFact> | undefined> = Array.from({ length: selections.length })
      for (const criterion of criteria) {
        const batchResults = yield* criterion.select(selections)
        for (let i = 0; i < selections.length; i++) {
          if (results[i] === undefined && batchResults[i] !== undefined) {
            results[i] = { criterion: criterion.id, ...batchResults[i] }
          }
        }
      }
      return results
    }),
})

/** Inverts a criterion. */
const criterionNot = <A, E, R>(
  criterion: Criterion<A, E, R>,
): Criterion<A, E, R> => ({
  id: `not(${criterion.id})`,
  select: (selections) =>
    Effect.map(criterion.select(selections), (batchResults) =>
      batchResults.map((res) => (res === undefined ? { negated: criterion.id } : undefined))
    ),
})

export const CriterionBase = {
  make: criterionMake,
  predicate: criterionPredicate,
  all: criterionAll,
  any: criterionAny,
  not: criterionNot,
}
