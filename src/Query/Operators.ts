/** Generic query stream operators. */
import { Effect, Predicate, Stream } from "effect"
import type { CallExpression, Node } from "typescript/unstable/ast"
import { isProjectFile, type ProjectFile } from "../Workspace/index.ts"
import {
  CriterionBase,
  QueryContractError,
  type Criterion,
  type Query,
  type Selection,
} from "./Model.ts"

/** Admit only selections the criterion produces evidence for. */
export const where =
  <A, E2, R2>(criterion: Criterion<A, E2, R2>) =>
  <E, R>(self: Query<A, E, R>): Query<A, E | E2 | QueryContractError, R | R2> =>
    self.pipe(
      Stream.grouped(criterion.batchSize ?? 128),
      Stream.mapEffect((batch) =>
        Effect.gen(function* () {
          const facts = yield* criterion.select(batch)
          if (facts.length !== batch.length) {
            return yield* new QueryContractError({
              criterion: criterion.id,
              expected: batch.length,
              actual: facts.length,
            })
          }
          return batch.flatMap((selection, index) => {
            const selectedFacts = facts[index]
            return selectedFacts === undefined
              ? []
              : [
                  {
                    ...selection,
                    evidence: [
                      ...selection.evidence,
                      { criterion: criterion.id, facts: selectedFacts },
                    ],
                  },
                ]
          })
        }),
      ),
      Stream.flatMap((batch) => Stream.fromIterable(batch)),
    )

const textIncludes =
  (pattern: string) =>
  <A extends Node>(selection: Selection<A>) => {
    const sourceFile = selection.value.getSourceFile()
    const text = selection.value.getText(sourceFile)
    return text.includes(pattern) ? { matchedText: text } : undefined
  }

const textMatchesRegExp =
  (pattern: RegExp) =>
  <A extends Node>(selection: Selection<A>) => {
    const sourceFile = selection.value.getSourceFile()
    const text = selection.value.getText(sourceFile)
    return pattern.test(text) ? { matchedText: text } : undefined
  }

/** Admit nodes whose text matches a string or regular expression. */
export const textMatches = <A extends Node>(pattern: string | RegExp): Criterion<A> =>
  CriterionBase.predicate(
    `text-matches:${String(pattern)}`,
    pattern instanceof RegExp ? textMatchesRegExp(pattern) : textIncludes(pattern),
  )

/** Selection-level predicate filter; evidence of surviving selections is preserved. */
export const filter =
  <A, E, R>(predicate: (selection: Selection<A>) => boolean) =>
  (self: Query<A, E, R>): Query<A, E, R> =>
    Stream.filter(self, predicate)

/**
 * Run a query to completion in canonical plan order: project ID,
 * project-relative file, start, end. Discovery timing never controls order.
 */
export const collect = <A, E, R>(
  self: Query<A, E, R>,
): Effect.Effect<ReadonlyArray<Selection<A>>, E, R> =>
  Stream.runCollect(self).pipe(
    Effect.map((selections) =>
      [...selections].sort(
        (left, right) =>
          left.project.project.id.localeCompare(right.project.project.id) ||
          left.fileName.localeCompare(right.fileName) ||
          left.start - right.start ||
          left.end - right.end,
      ),
    ),
  )

/** Filter selections to only those whose project-relative fileName matches a glob pattern, suffix, RegExp, or ProjectFile. */
export const within =
  <A>(pattern: string | RegExp | ProjectFile) =>
  <E, R>(query: Query<A, E, R>): Query<A, E, R> => {
    if (isProjectFile(pattern)) {
      return Stream.filter(
        query,
        (selection) =>
          selection.project.project.id === pattern.project.project.id &&
          selection.fileName === pattern.path,
      )
    }
    const predicate = Predicate.isString(pattern)
      ? (fileName: string) => {
          if (pattern.includes("*")) {
            const regex = new RegExp(
              "^" +
                pattern
                  .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                  .replace(/\*\*/g, ".*")
                  .replace(/\*/g, "[^/]*") +
                "$",
            )
            return regex.test(fileName)
          }
          return fileName.includes(pattern) || fileName.endsWith(pattern)
        }
      : (fileName: string) => pattern.test(fileName)

    return Stream.filter(query, (selection) => predicate(selection.fileName))
  }

/** Filter call expressions by argument count. */
export const withArgCount =
  (count: number | { readonly min?: number; readonly max?: number }) =>
  <E, R>(query: Query<CallExpression, E, R>): Query<CallExpression, E, R> =>
    Stream.filter(query, (selection) => {
      const len = selection.value.arguments.length
      if (Predicate.isNumber(count)) return len === count
      if (count.min !== undefined && len < count.min) return false
      if (count.max !== undefined && len > count.max) return false
      return true
    })
