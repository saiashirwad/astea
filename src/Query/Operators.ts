/** Generic query stream operators. */
import { Effect, Function, Predicate, Stream } from "effect"
import type { CallExpression, Node } from "typescript/unstable/ast"
import { isProjectFile, type ProjectFile } from "../Workspace/index.ts"
import {
  CriterionBase,
  QueryContractError,
  type Criterion,
  type Query,
  type Selection,
} from "./Query.ts"

/** Admit only selections the criterion produces evidence for. */
export const where = Function.dual<
  <A, E2, R2>(
    criterion: Criterion<A, E2, R2>,
  ) => <E, R>(self: Query<A, E, R>) => Query<A, E | E2 | QueryContractError, R | R2>,
  <A, E, R, E2, R2>(
    self: Query<A, E, R>,
    criterion: Criterion<A, E2, R2>,
  ) => Query<A, E | E2 | QueryContractError, R | R2>
>(2, (self, criterion) =>
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
  ),
)

const textIncludes =
  (pattern: string) =>
  <A extends Node>(selection: Selection<A>) => {
    const sourceFile = selection.value.getSourceFile()
    const text = selection.value.getText(sourceFile)
    return text.includes(pattern) ? { matchedText: text } : undefined
  }

const testRegExp = (pattern: RegExp, value: string): boolean => {
  const fresh = new RegExp(pattern.source, pattern.flags)
  return fresh.test(value)
}

const textMatchesRegExp =
  (pattern: RegExp) =>
  <A extends Node>(selection: Selection<A>) => {
    const sourceFile = selection.value.getSourceFile()
    const text = selection.value.getText(sourceFile)
    return testRegExp(pattern, text) ? { matchedText: text } : undefined
  }

/** Admit nodes whose text matches a string or regular expression. */
export const textMatches = <A extends Node>(pattern: string | RegExp): Criterion<A> =>
  CriterionBase.predicate(
    `text-matches:${String(pattern)}`,
    pattern instanceof RegExp ? textMatchesRegExp(pattern) : textIncludes(pattern),
  )

/** Selection-level predicate filter; evidence of surviving selections is preserved. */
export const filter = Function.dual<
  <A>(
    predicate: (selection: Selection<A>) => boolean,
  ) => <E, R>(self: Query<A, E, R>) => Query<A, E, R>,
  <A, E, R>(self: Query<A, E, R>, predicate: (selection: Selection<A>) => boolean) => Query<A, E, R>
>(2, (self, predicate) => Stream.filter(self, predicate))

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

const escapeGlobRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Match a project-relative path against a documented `*` / `**` glob. */
export const matchesPathGlob = (fileName: string, glob: string): boolean => {
  const path = fileName.replaceAll("\\", "/")
  const pattern = glob.replaceAll("\\", "/")
  let source = "^"
  for (let index = 0; index < pattern.length;) {
    if (pattern[index] === "*" && pattern[index + 1] === "*") {
      index += 2
      if (pattern[index] === "/") {
        index += 1
        source += "(?:.*/)?"
      } else {
        source += ".*"
      }
      continue
    }
    if (pattern[index] === "*") {
      source += "[^/]*"
      index += 1
      continue
    }
    source += escapeGlobRegExp(pattern[index]!)
    index += 1
  }
  return new RegExp(`${source}$`).test(path)
}

/** Filter selections to only those whose project-relative fileName matches a glob pattern, suffix, RegExp, or ProjectFile. */
export const within = Function.dual<
  <A>(pattern: string | RegExp | ProjectFile) => <E, R>(query: Query<A, E, R>) => Query<A, E, R>,
  <A, E, R>(query: Query<A, E, R>, pattern: string | RegExp | ProjectFile) => Query<A, E, R>
>(2, (query, pattern) => {
  if (isProjectFile(pattern)) {
    return Stream.filter(
      query,
      (selection) =>
        selection.project.project.id === pattern.project.project.id &&
        selection.fileName === pattern.path,
    )
  }
  const predicate = Predicate.isString(pattern)
    ? (fileName: string) =>
        pattern.includes("*")
          ? matchesPathGlob(fileName, pattern)
          : fileName.includes(pattern) || fileName.endsWith(pattern)
    : (fileName: string) => testRegExp(pattern, fileName)

  return Stream.filter(query, (selection) => predicate(selection.fileName))
})

/** Filter call expressions by argument count. */
export const withArgCount = Function.dual<
  (
    count: number | { readonly min?: number; readonly max?: number },
  ) => <E, R>(query: Query<CallExpression, E, R>) => Query<CallExpression, E, R>,
  <E, R>(
    query: Query<CallExpression, E, R>,
    count: number | { readonly min?: number; readonly max?: number },
  ) => Query<CallExpression, E, R>
>(2, (query, count) =>
  Stream.filter(query, (selection) => {
    const len = selection.value.arguments.length
    if (Predicate.isNumber(count)) return len === count
    if (count.min !== undefined && len < count.min) return false
    if (count.max !== undefined && len > count.max) return false
    return true
  }),
)
