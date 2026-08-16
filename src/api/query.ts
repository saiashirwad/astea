/**
 * Candidate public API — semantic queries.
 *
 * A Query is an Effect Stream of evidence-bearing Selections over native
 * TypeScript values. Selections carry the Project Snapshot they came from, so
 * semantic criteria (`Query.resolvesTo`, custom `Criterion`s) need no project
 * argument and compose across a multi-project workspace. Native node types
 * flow through with exact inference — there is no wrapper hierarchy.
 */
import { path as Path } from "../platform/node.ts"
import { Data, Effect, Predicate, Stream } from "effect"
import {
  getJSDocTags,
  SyntaxKind,
  type CallExpression,
  type Identifier,
  type ImportDeclaration,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
} from "typescript/unstable/ast"
import {
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConstructorDeclaration,
  isEnumDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isModuleDeclaration,
  isPropertyAccessExpression,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSourceFile,
  isTypeAliasDeclaration,
} from "typescript/unstable/ast/is"
import { SymbolFlags, type Symbol as NativeSymbol, type Type as NativeType } from "typescript/unstable/async"
import { type NativeCompilerError, nativeRequest } from "../internal/native-compiler.ts"
import { isWithinProject, projectRelativePath } from "../internal/project-path.ts"
import type { Pattern } from "./pattern.ts"
import { isProjectFile, type ProjectFile, type ProjectSnapshot, type ProjectSnapshotError, type SnapshotExpired } from "./workspace.ts"

export type ProjectScope = ProjectSnapshot | ProjectFile | ReadonlyArray<ProjectFile>

export interface TargetFileScope {
  readonly project: ProjectSnapshot
  readonly fileName: string
}

const isProjectFileArray = (
  value: ProjectScope,
): value is ReadonlyArray<ProjectFile> => Array.isArray(value)

const resolveScope = (
  scope: ProjectScope,
): Stream.Stream<TargetFileScope, ProjectSnapshotError> => {
  if (isProjectFileArray(scope)) {
    if (scope.length === 0) {
      return Stream.empty
    }
    const seen = new Set<string>()
    const uniqueFiles: Array<TargetFileScope> = []
    for (const f of scope) {
      const key = `${f.project.project.id}:${f.path}`
      if (!seen.has(key)) {
        seen.add(key)
        uniqueFiles.push({
          project: f.project,
          fileName: Path.resolve(f.project.root, f.path),
        })
      }
    }
    return Stream.fromIterable(uniqueFiles)
  }
  if (isProjectFile(scope)) {
    return Stream.make({
      project: scope.project,
      fileName: Path.resolve(scope.project.root, scope.path),
    })
  }
  return Stream.fromIterableEffect(
    scope.sourceFileNames.pipe(
      Effect.map((fileNames) =>
        fileNames.map((fileName) => ({
          project: scope,
          fileName,
        }))
      ),
    ),
  )
}

export type EvidenceFact = string | number | boolean | null

/** Deterministic facts explaining why a Selection qualified. */
export interface QueryEvidence {
  readonly criterion: string
  readonly facts: Readonly<Record<string, EvidenceFact>>
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

export interface InsideOptions {
  readonly stopBy?: "boundary" | "root"
}

export interface HasOptions {
  readonly stopBy?: "boundary" | "root"
}

export interface SiblingOptions {
  readonly immediately?: boolean
}

export type RelationalMatcher<Out = unknown, E = never, R = never> =
  | Pattern<Node, Out>
  | Criterion<Node, E, R>
  | ((node: Node) => boolean)

const isMatcherPattern = (
  matcher: RelationalMatcher<any, any, any>,
): matcher is Pattern<Node, unknown> =>
  Predicate.isObject(matcher) &&
  Predicate.hasProperty(matcher, "match") &&
  Predicate.isFunction(matcher.match)

const isMatcherCriterion = (
  matcher: RelationalMatcher<any, any, any>,
): matcher is Criterion<Node, any, any> =>
  Predicate.isObject(matcher) &&
  Predicate.hasProperty(matcher, "select") &&
  Predicate.isFunction(matcher.select)

const matcherId = (matcher: RelationalMatcher<any, any, any>): string => {
  if (isMatcherPattern(matcher)) {
    return matcher.kind ?? "pattern"
  }
  if (isMatcherCriterion(matcher)) {
    return matcher.id
  }
  if (Predicate.isFunction(matcher)) {
    return matcher.name || "predicate"
  }
  return "custom"
}

const evaluateMatcher = <Out, E, R>(
  matcher: RelationalMatcher<Out, E, R>,
  node: Node,
  project: ProjectSnapshot,
  fileName: string,
): Effect.Effect<
  { readonly matched: boolean; readonly facts?: Readonly<Record<string, EvidenceFact>> },
  E | ProjectSnapshotError,
  R
> => {
  if (isMatcherPattern(matcher)) {
    return Effect.map(matcher.match(node, project), (result) =>
      result.matched ? { matched: true, facts: result.facts } : { matched: false }
    )
  }
  if (isMatcherCriterion(matcher)) {
    const sourceFile = node.getSourceFile()
    const candidateSelection: Selection<Node> = {
      value: node,
      project,
      fileName,
      start: node.getStart(sourceFile),
      end: node.getEnd(),
      evidence: [],
    }
    return Effect.map(matcher.select([candidateSelection]), (factsList) => {
      const facts = factsList[0]
      return facts !== undefined ? { matched: true, facts } : { matched: false }
    })
  }
  if (Predicate.isFunction(matcher)) {
    const matched = matcher(node)
    return Effect.succeed(
      matched
        ? {
            matched: true,
            facts: { kind: SyntaxKind[node.kind] ?? String(node.kind) },
          }
        : { matched: false },
    )
  }
  return Effect.succeed({ matched: false })
}

const isBoundaryNode = (node: Node): boolean =>
  isFunctionDeclaration(node) ||
  isFunctionExpression(node) ||
  isArrowFunction(node) ||
  isMethodDeclaration(node) ||
  isGetAccessorDeclaration(node) ||
  isSetAccessorDeclaration(node) ||
  isConstructorDeclaration(node) ||
  isClassDeclaration(node) ||
  isClassExpression(node) ||
  isInterfaceDeclaration(node) ||
  isTypeAliasDeclaration(node) ||
  isEnumDeclaration(node) ||
  isModuleDeclaration(node) ||
  isSourceFile(node)

const getSiblingsAndIndex = (
  node: Node,
): { readonly siblings: ReadonlyArray<Node>; readonly index: number } | undefined => {
  if (node.parent === undefined) return undefined

  const parent = node.parent
  const children: Array<Node> = []
  parent.forEachChild((child) => {
    children.push(child)
    return undefined
  })

  if (
    children.length === 1 &&
    isExpressionStatement(parent) &&
    parent.parent !== undefined
  ) {
    const statementParent = parent.parent
    const statementChildren: Array<Node> = []
    statementParent.forEachChild((child) => {
      statementChildren.push(child)
      return undefined
    })
    const statementIndex = statementChildren.findIndex(
      (c) => c === parent || (c.pos === parent.pos && c.end === parent.end),
    )
    if (statementIndex !== -1) {
      return { siblings: statementChildren, index: statementIndex }
    }
  }

  const index = children.findIndex(
    (c) => c === node || (c.pos === node.pos && c.end === node.end),
  )
  if (index === -1) return undefined
  return { siblings: children, index }
}

const evaluateSibling = <Out, E, R>(
  matcher: RelationalMatcher<Out, E, R>,
  sibling: Node,
  project: ProjectSnapshot,
  fileName: string,
): Effect.Effect<
  { readonly matched: boolean; readonly facts?: Readonly<Record<string, EvidenceFact>>; readonly node: Node },
  E | ProjectSnapshotError,
  R
> =>
  Effect.gen(function*() {
    const directOutcome = yield* evaluateMatcher(matcher, sibling, project, fileName)
    if (directOutcome.matched) {
      return { matched: true, facts: directOutcome.facts, node: sibling }
    }

    if (isExpressionStatement(sibling)) {
      const exprOutcome = yield* evaluateMatcher(matcher, sibling.expression, project, fileName)
      if (exprOutcome.matched) {
        return { matched: true, facts: exprOutcome.facts, node: sibling.expression }
      }
    }

    if (isReturnStatement(sibling) && sibling.expression !== undefined) {
      const exprOutcome = yield* evaluateMatcher(matcher, sibling.expression, project, fileName)
      if (exprOutcome.matched) {
        return { matched: true, facts: exprOutcome.facts, node: sibling.expression }
      }
    }

    return { matched: false, node: sibling }
  })

const criterionInside = <A extends Node, Out = unknown, E = never, R = never>(
  matcher: RelationalMatcher<Out, E, R>,
  options?: InsideOptions,
): Criterion<A, E | ProjectSnapshotError, R> => ({
  id: `inside(${matcherId(matcher)})`,
  select: (selections) =>
    Effect.gen(function*() {
      const results: Array<Readonly<Record<string, EvidenceFact>> | undefined> = []
      for (const selection of selections) {
        let current: Node | undefined = selection.value.parent
        let matchedFacts: Readonly<Record<string, EvidenceFact>> | undefined

        while (current !== undefined) {
          const outcome = yield* evaluateMatcher(
            matcher,
            current,
            selection.project,
            selection.fileName,
          )
          if (outcome.matched) {
            const ancestorKind = SyntaxKind[current.kind] ?? String(current.kind)
            matchedFacts = {
              ancestorKind,
              ...outcome.facts,
            }
            break
          }
          if (options?.stopBy === "boundary" && isBoundaryNode(current)) {
            break
          }
          current = current.parent
        }

        results.push(matchedFacts)
      }
      return results
    }),
})

const criterionHas = <A extends Node, Out = unknown, E = never, R = never>(
  matcher: RelationalMatcher<Out, E, R>,
  options?: HasOptions,
): Criterion<A, E | ProjectSnapshotError, R> => ({
  id: `has(${matcherId(matcher)})`,
  select: (selections) =>
    Effect.gen(function*() {
      const results: Array<Readonly<Record<string, EvidenceFact>> | undefined> = []
      for (const selection of selections) {
        let matchedFacts: Readonly<Record<string, EvidenceFact>> | undefined

        const search = (node: Node): Effect.Effect<void, E | ProjectSnapshotError, R> =>
          Effect.gen(function*() {
            const children: Array<Node> = []
            node.forEachChild((child) => {
              children.push(child)
              return undefined
            })

            for (const child of children) {
              if (matchedFacts !== undefined) break

              const outcome = yield* evaluateMatcher(
                matcher,
                child,
                selection.project,
                selection.fileName,
              )
              if (outcome.matched) {
                const descendantKind = SyntaxKind[child.kind] ?? String(child.kind)
                matchedFacts = {
                  descendantKind,
                  ...outcome.facts,
                }
                break
              }

              if (options?.stopBy === "boundary" && isBoundaryNode(child)) {
                continue
              }

              yield* search(child)
            }
          })

        yield* search(selection.value)
        results.push(matchedFacts)
      }
      return results
    }),
})

const criterionPrecedes = <A extends Node, Out = unknown, E = never, R = never>(
  matcher: RelationalMatcher<Out, E, R>,
  options?: SiblingOptions,
): Criterion<A, E | ProjectSnapshotError, R> => ({
  id: `precedes(${matcherId(matcher)})`,
  select: (selections) =>
    Effect.gen(function*() {
      const results: Array<Readonly<Record<string, EvidenceFact>> | undefined> = []
      for (const selection of selections) {
        const siblingInfo = getSiblingsAndIndex(selection.value)
        if (siblingInfo === undefined) {
          results.push(undefined)
          continue
        }

        const { siblings, index } = siblingInfo
        let matchedFacts: Readonly<Record<string, EvidenceFact>> | undefined

        if (options?.immediately) {
          if (index < siblings.length - 1) {
            const followingSibling = siblings[index + 1]!
            const outcome = yield* evaluateSibling(matcher, followingSibling, selection.project, selection.fileName)
            if (outcome.matched) {
              const siblingKind = SyntaxKind[outcome.node.kind] ?? String(outcome.node.kind)
              matchedFacts = {
                siblingKind,
                ...outcome.facts,
              }
            }
          }
        } else {
          for (let i = index + 1; i < siblings.length; i++) {
            const followingSibling = siblings[i]!
            const outcome = yield* evaluateSibling(matcher, followingSibling, selection.project, selection.fileName)
            if (outcome.matched) {
              const siblingKind = SyntaxKind[outcome.node.kind] ?? String(outcome.node.kind)
              matchedFacts = {
                siblingKind,
                ...outcome.facts,
              }
              break
            }
          }
        }

        results.push(matchedFacts)
      }
      return results
    }),
})

const criterionFollows = <A extends Node, Out = unknown, E = never, R = never>(
  matcher: RelationalMatcher<Out, E, R>,
  options?: SiblingOptions,
): Criterion<A, E | ProjectSnapshotError, R> => ({
  id: `follows(${matcherId(matcher)})`,
  select: (selections) =>
    Effect.gen(function*() {
      const results: Array<Readonly<Record<string, EvidenceFact>> | undefined> = []
      for (const selection of selections) {
        const siblingInfo = getSiblingsAndIndex(selection.value)
        if (siblingInfo === undefined) {
          results.push(undefined)
          continue
        }

        const { siblings, index } = siblingInfo
        let matchedFacts: Readonly<Record<string, EvidenceFact>> | undefined

        if (options?.immediately) {
          if (index > 0) {
            const precedingSibling = siblings[index - 1]!
            const outcome = yield* evaluateSibling(matcher, precedingSibling, selection.project, selection.fileName)
            if (outcome.matched) {
              const siblingKind = SyntaxKind[outcome.node.kind] ?? String(outcome.node.kind)
              matchedFacts = {
                siblingKind,
                ...outcome.facts,
              }
            }
          }
        } else {
          for (let i = index - 1; i >= 0; i--) {
            const precedingSibling = siblings[i]!
            const outcome = yield* evaluateSibling(matcher, precedingSibling, selection.project, selection.fileName)
            if (outcome.matched) {
              const siblingKind = SyntaxKind[outcome.node.kind] ?? String(outcome.node.kind)
              matchedFacts = {
                siblingKind,
                ...outcome.facts,
              }
              break
            }
          }
        }

        results.push(matchedFacts)
      }
      return results
    }),
})

export const Criterion = {
  make: criterionMake,
  predicate: criterionPredicate,
  all: criterionAll,
  any: criterionAny,
  not: criterionNot,
  inside: criterionInside,
  has: criterionHas,
  precedes: criterionPrecedes,
  preceding: criterionPrecedes,
  follows: criterionFollows,
  following: criterionFollows,
}

const collectNodes = <A extends Node>(
  project: ProjectSnapshot,
  sourceFile: SourceFile,
  guard: (node: Node) => node is A,
): Array<Selection<A>> => {
  const selections: Array<Selection<A>> = []
  const fileName = isWithinProject(project.root, sourceFile.fileName)
    ? projectRelativePath(project.root, sourceFile.fileName)
    : sourceFile.fileName

  const visit = (node: Node): void => {
    if (guard(node)) {
      selections.push({
        value: node,
        project,
        fileName,
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        evidence: [{
          criterion: "syntax-kind",
          facts: { kind: SyntaxKind[node.kind] ?? node.kind },
        }],
      })
    }
    node.forEachChild((child) => {
      visit(child)
      return undefined
    })
  }

  visit(sourceFile)
  return selections
}

/** All descendant nodes of the given kind, in every file the project checks. */
export const nodes = <A extends Node>(
  target: ProjectScope,
  guard: (node: Node) => node is A,
): Query<A, ProjectSnapshotError> =>
  resolveScope(target).pipe(
    Stream.flatMap(({ project, fileName }) =>
      Stream.fromEffect(project.unsafeNative((nativeProject) =>
        nativeRequest("getSourceFile", () => nativeProject.program.getSourceFile(fileName))
      )).pipe(
        Stream.flatMap((sourceFile) =>
          sourceFile === undefined ? Stream.empty : Stream.fromIterable(collectNodes(project, sourceFile, guard))
        ),
      )
    ),
  )

export const calls = (target: ProjectScope): Query<CallExpression, ProjectSnapshotError> =>
  nodes(target, isCallExpression)

export const imports = (target: ProjectScope): Query<ImportDeclaration, ProjectSnapshotError> =>
  nodes(target, isImportDeclaration)

export const identifiers = (target: ProjectScope): Query<Identifier, ProjectSnapshotError> =>
  nodes(target, isIdentifier)

export const propertyAccesses = (
  target: ProjectScope,
): Query<PropertyAccessExpression, ProjectSnapshotError> =>
  nodes(target, isPropertyAccessExpression)

/** Structural pattern matching query. */
export const match = <Out>(
  target: ProjectScope,
  pattern: Pattern<Node, Out>,
): Query<Out, ProjectSnapshotError> =>
  resolveScope(target).pipe(
    Stream.flatMap(({ project, fileName }) =>
      Stream.fromEffect(project.unsafeNative((nativeProject) =>
        nativeRequest("getSourceFile", () => nativeProject.program.getSourceFile(fileName))
      )).pipe(
        Stream.flatMap((sourceFile) => {
          if (sourceFile === undefined) return Stream.empty
          const candidateNodes: Array<Node> = []
          const visit = (node: Node) => {
            candidateNodes.push(node)
            node.forEachChild((child) => {
              visit(child)
              return undefined
            })
          }
          visit(sourceFile)

          return Stream.fromIterable(candidateNodes).pipe(
            Stream.mapEffect((node) =>
              pattern.match(node, project).pipe(
                Effect.map((result): Selection<Out> | undefined => {
                  if (!result.matched) return undefined
                  const relFileName = isWithinProject(project.root, sourceFile.fileName)
                    ? projectRelativePath(project.root, sourceFile.fileName)
                    : sourceFile.fileName
                  return {
                    value: result.value,
                    project,
                    fileName: relFileName,
                    start: node.getStart(sourceFile),
                    end: node.getEnd(),
                    evidence: [{
                      criterion: pattern.kind ?? "pattern-match",
                      facts: result.facts === undefined
                        ? { kind: SyntaxKind[node.kind] ?? node.kind }
                        : { kind: SyntaxKind[node.kind] ?? node.kind, ...result.facts },
                    }],
                  }
                })
              )
            ),
            Stream.filter((selection): selection is Selection<Out> => selection !== undefined),
          )
        }),
      )
    ),
  )

/** Admit only selections the criterion produces evidence for. */
export const where = <A, E2, R2>(
  criterion: Criterion<A, E2, R2>,
) =>
<E, R>(self: Query<A, E, R>): Query<A, E | E2 | QueryContractError, R | R2> =>
  self.pipe(
    Stream.grouped(criterion.batchSize ?? 128),
    Stream.mapEffect((batch) =>
      Effect.gen(function*() {
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
            : [{
              ...selection,
              evidence: [...selection.evidence, { criterion: criterion.id, facts: selectedFacts }],
            }]
        })
      })
    ),
    Stream.flatMap((batch) => Stream.fromIterable(batch)),
  )

/**
 * Admit nodes that resolve to the given canonical symbol, through import
 * aliases and re-exports. Uses the native checker's batched position lookups.
 */
export const resolvesTo = <A extends Node>(
  symbol: NativeSymbol,
  options?: { readonly location?: (candidate: A) => Node },
): Criterion<A, NativeCompilerError | SnapshotExpired> => ({
  id: "resolves-to-symbol",
  select: (selections) =>
    Effect.gen(function*() {
      const byProjectFile = Map.groupBy(
        selections.map((selection, index) => ({ selection, index })),
        ({ selection }) => `${selection.project.project.id}${selection.fileName}`,
      )
      const facts: Array<Readonly<Record<string, EvidenceFact>> | undefined> = Array.from({
        length: selections.length,
      })
      yield* Effect.all([...byProjectFile.values()].map((group) =>
        Effect.gen(function*() {
          const project = group[0]!.selection.project
          const location = options?.location ?? ((candidate: A): Node => candidate)
          const positions = group.map(({ selection }) => {
            const node = location(selection.value)
            return node.getStart(node.getSourceFile())
          })
          const fileName = Path.resolve(project.root, group[0]!.selection.fileName)
          const symbols = yield* project.unsafeNative((nativeProject) =>
            nativeRequest(
              "getSymbolsAtPositions",
              () => nativeProject.checker.getSymbolAtPosition(fileName, positions),
            ))
          yield* Effect.forEach(symbols, (candidate, index) =>
            candidate === undefined ? Effect.void : Effect.gen(function*() {
              const canonical = yield* project.unsafeNative((nativeProject) =>
                (candidate.flags & SymbolFlags.Alias) === 0
                  ? Effect.succeed(candidate)
                  : nativeRequest(
                    "getAliasedSymbol",
                    () => nativeProject.checker.getAliasedSymbol(candidate),
                  ))
              if (canonical === symbol) {
                const declarationFile = symbol.valueDeclaration?.path ?? symbol.declarations[0]?.path
                facts[group[index]!.index] = {
                  symbol: symbol.name,
                  declarationFile: declarationFile === undefined
                    ? "unknown"
                    : projectRelativePath(project.root, String(declarationFile)),
                }
              }
            }))
        })
      ), { concurrency: 8 })
      return facts
    }),
})

/** Admit nodes that have a specific JSDoc tag (e.g. `@deprecated`, `@internal`). */
export const hasJSDocTag = <A extends Node>(
  tagName: string,
): Criterion<A> =>
  criterionPredicate(`jsdoc-tag:${tagName}`, (selection) => {
    const normalizedTag = tagName.replace(/^@/, "")
    const tags = getJSDocTags(selection.value)
    const match = tags.find((t) => t.tagName.text === normalizedTag)
    return match !== undefined ? { tag: normalizedTag } : undefined
  })

interface NodeWithModifiers extends Node {
  readonly modifiers?: ReadonlyArray<{ readonly kind: SyntaxKind }>
}

const hasModifiers = (node: Node): node is NodeWithModifiers => "modifiers" in node

const readModifiers = (node: Node): ReadonlyArray<{ readonly kind: SyntaxKind }> | undefined => {
  if (!hasModifiers(node) || node.modifiers === undefined) return undefined
  return node.modifiers
}

/** Admit nodes that have an export modifier. */
export const isExported = <A extends Node>(): Criterion<A> =>
  criterionPredicate("is-exported", (selection) => {
    const modifiers = readModifiers(selection.value)
    const hasExport = modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) ?? false
    return hasExport ? { exported: true } : undefined
  })

const textIncludes = (pattern: string) => <A extends Node>(selection: Selection<A>) => {
  const sourceFile = selection.value.getSourceFile()
  const text = selection.value.getText(sourceFile)
  return text.includes(pattern) ? { matchedText: text } : undefined
}

const textMatchesRegExp = (pattern: RegExp) => <A extends Node>(selection: Selection<A>) => {
  const sourceFile = selection.value.getSourceFile()
  const text = selection.value.getText(sourceFile)
  return pattern.test(text) ? { matchedText: text } : undefined
}

/** Admit nodes whose text matches a string or regular expression. */
export const textMatches = <A extends Node>(
  pattern: string | RegExp,
): Criterion<A> =>
  criterionPredicate(
    `text-matches:${String(pattern)}`,
    pattern instanceof RegExp ? textMatchesRegExp(pattern) : textIncludes(pattern),
  )

/** Selection-level predicate filter; evidence of surviving selections is preserved. */
export const filter = <A, E, R>(
  predicate: (selection: Selection<A>) => boolean,
) =>
(self: Query<A, E, R>): Query<A, E, R> => Stream.filter(self, predicate)

/**
 * Run a query to completion in canonical plan order: project ID,
 * project-relative file, start, end. Discovery timing never controls order.
 */
export const collect = <A, E, R>(
  self: Query<A, E, R>,
): Effect.Effect<ReadonlyArray<Selection<A>>, E, R> =>
  Stream.runCollect(self).pipe(
    Effect.map((selections) =>
      [...selections].sort((left, right) =>
        left.project.project.id.localeCompare(right.project.project.id) ||
        left.fileName.localeCompare(right.fileName) ||
        left.start - right.start ||
        left.end - right.end
      )
    ),
  )

/** Find all occurrences across all files in the project that resolve to the given canonical symbol. */
export const referencesTo = (
  target: ProjectScope,
  symbol: NativeSymbol,
): Query<Identifier, ProjectSnapshotError | QueryContractError> =>
  identifiers(target).pipe(where(resolvesTo(symbol)))

/** Inspect the computed TypeScript Type of a node. */
export const typeOf = (
  target: ProjectSnapshot | ProjectFile,
  node: Node,
): Effect.Effect<NativeType | undefined, ProjectSnapshotError> => {
  const project = isProjectFile(target) ? target.project : target
  const sourceFile = node.getSourceFile()
  const fileName = projectRelativePath(project.root, sourceFile.fileName)
  const pos = node.getStart(sourceFile)
  return project.typeAt(fileName, pos)
}

export type IntrinsicTypeName = "string" | "number" | "boolean" | "any" | "unknown" | "never" | "void"

const isIntrinsicTypeName = (value: NativeType | IntrinsicTypeName): value is IntrinsicTypeName =>
  Predicate.isString(value)

/** Admit nodes whose computed type is assignable to `target`. */
export const typeAssignableTo = <A extends Node>(
  target: NativeType | IntrinsicTypeName,
): Criterion<A, NativeCompilerError | SnapshotExpired> => {
  const targetLabel = isIntrinsicTypeName(target) ? target : "custom-type"
  return {
    id: `type-assignable-to:${targetLabel}`,
    select: (selections) =>
      Effect.gen(function*() {
        const facts: Array<Readonly<Record<string, EvidenceFact>> | undefined> = Array.from({
          length: selections.length,
        })
        for (let i = 0; i < selections.length; i++) {
          const selection = selections[i]!
          const node = selection.value
          const sourceFile = node.getSourceFile()
          const pos = node.getStart(sourceFile)
          const nodeType = yield* selection.project.typeAt(selection.fileName, pos)
          if (nodeType === undefined) continue

          const expectedType = isIntrinsicTypeName(target)
            ? yield* selection.project.intrinsicType(target)
            : target

          const assignable = yield* selection.project.isTypeAssignableTo(nodeType, expectedType)
          if (assignable) {
            const typeStr = yield* selection.project.typeToString(nodeType)
            facts[i] = {
              type: typeStr,
              assignableTo: isIntrinsicTypeName(target) ? target : "type",
            }
          }
        }
        return facts
      }),
  }
}

/** Admit nodes whose computed type satisfies a custom predicate. */
export const typeSatisfies = <A extends Node>(
  id: string,
  predicate: (type: NativeType, typeString: string) => boolean,
): Criterion<A, NativeCompilerError | SnapshotExpired> => ({
  id: `type-satisfies:${id}`,
  select: (selections) =>
    Effect.gen(function*() {
      const facts: Array<Readonly<Record<string, EvidenceFact>> | undefined> = Array.from({
        length: selections.length,
      })
      for (let i = 0; i < selections.length; i++) {
        const selection = selections[i]!
        const node = selection.value
        const sourceFile = node.getSourceFile()
        const pos = node.getStart(sourceFile)
        const nodeType = yield* selection.project.typeAt(selection.fileName, pos)
        if (nodeType === undefined) continue

        const typeStr = yield* selection.project.typeToString(nodeType)
        if (predicate(nodeType, typeStr)) {
          facts[i] = { type: typeStr, predicate: id }
        }
      }
      return facts
    }),
})

/** Filter selections to only those whose project-relative fileName matches a glob pattern, suffix, RegExp, or ProjectFile. */
export const within = <A>(
  pattern: string | RegExp | ProjectFile,
) => <E, R>(query: Query<A, E, R>): Query<A, E, R> => {
  if (isProjectFile(pattern)) {
    return Stream.filter(query, (selection) =>
      selection.project.project.id === pattern.project.project.id &&
      selection.fileName === pattern.path
    )
  }
  const predicate = Predicate.isString(pattern)
    ? (fileName: string) => {
        if (pattern.includes("*")) {
          const regex = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$")
          return regex.test(fileName)
        }
        return fileName.includes(pattern) || fileName.endsWith(pattern)
      }
    : (fileName: string) => pattern.test(fileName)

  return Stream.filter(query, (selection) => predicate(selection.fileName))
}

/** Filter call expressions by argument count. */
export const withArgCount = (
  count: number | { readonly min?: number; readonly max?: number },
) => <E, R>(query: Query<CallExpression, E, R>): Query<CallExpression, E, R> =>
  Stream.filter(query, (selection) => {
    const len = selection.value.arguments.length
    if (Predicate.isNumber(count)) return len === count
    if (count.min !== undefined && len < count.min) return false
    if (count.max !== undefined && len > count.max) return false
    return true
  })

/** Filter selections to only those nested inside an ancestor matching the given pattern, criterion, or predicate. */
export const inside = <Out = unknown, E2 = never, R2 = never>(
  matcher: RelationalMatcher<Out, E2, R2>,
  options?: InsideOptions,
) =>
<A extends Node, E, R>(
  self: Query<A, E, R>,
): Query<A, E | E2 | ProjectSnapshotError | QueryContractError, R | R2> =>
  where(criterionInside<A, Out, E2, R2>(matcher, options))(self)

/** Filter selections to only those containing a descendant matching the given pattern, criterion, or predicate. */
export const has = <Out = unknown, E2 = never, R2 = never>(
  matcher: RelationalMatcher<Out, E2, R2>,
  options?: HasOptions,
) =>
<A extends Node, E, R>(
  self: Query<A, E, R>,
): Query<A, E | E2 | ProjectSnapshotError | QueryContractError, R | R2> =>
  where(criterionHas<A, Out, E2, R2>(matcher, options))(self)

/** Filter selections to only those preceding a sibling matching the given pattern, criterion, or predicate. */
export const precedes = <Out = unknown, E2 = never, R2 = never>(
  matcher: RelationalMatcher<Out, E2, R2>,
  options?: SiblingOptions,
) =>
<A extends Node, E, R>(
  self: Query<A, E, R>,
): Query<A, E | E2 | ProjectSnapshotError | QueryContractError, R | R2> =>
  where(criterionPrecedes<A, Out, E2, R2>(matcher, options))(self)

/** Alias for `precedes`. */
export const preceding = precedes

/** Filter selections to only those following a sibling matching the given pattern, criterion, or predicate. */
export const follows = <Out = unknown, E2 = never, R2 = never>(
  matcher: RelationalMatcher<Out, E2, R2>,
  options?: SiblingOptions,
) =>
<A extends Node, E, R>(
  self: Query<A, E, R>,
): Query<A, E | E2 | ProjectSnapshotError | QueryContractError, R | R2> =>
  where(criterionFollows<A, Out, E2, R2>(matcher, options))(self)

/** Alias for `follows`. */
export const following = follows

export const Query = {
  nodes,
  calls,
  imports,
  identifiers,
  propertyAccesses,
  referencesTo,
  typeOf,
  typeAssignableTo,
  typeSatisfies,
  match,
  where,
  within,
  withArgCount,
  inside,
  has,
  precedes,
  preceding,
  follows,
  following,
  resolvesTo,
  hasJSDocTag,
  isExported,
  textMatches,
  filter,
  collect,
}
