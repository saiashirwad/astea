/** AST ancestry, containment, and sibling relations. */
import { Effect, Predicate } from "effect"
import { SyntaxKind, type Node } from "typescript/unstable/ast"
import {
  isArrowFunction,
  isClassDeclaration,
  isClassExpression,
  isConstructorDeclaration,
  isEnumDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isModuleDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSourceFile,
  isTypeAliasDeclaration,
} from "typescript/unstable/ast/is"
import type { EvidenceFact } from "../Evidence/Evidence.ts"
import type { ProjectRelativePath } from "../ProjectPath/index.ts"
import type { NodeCriterion } from "../Pattern/index.ts"
import type { ProjectSnapshot, ProjectSnapshotError } from "../Workspace/index.ts"
import type { Criterion, Query, QueryContractError, Selection } from "./Query.ts"
import { where } from "./Operators.ts"

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
  | NodeCriterion<Node, Out>
  | Criterion<Node, E, R>
  | ((node: Node) => boolean)

const matcherId = <Out, E, R>(matcher: RelationalMatcher<Out, E, R>): string => {
  if (Predicate.isFunction(matcher)) {
    return matcher.name || "predicate"
  }
  if (matcher.mode === "node") {
    return matcher.kind ?? "pattern"
  }
  return matcher.id
}

const evaluateMatcher = <Out, E, R>(
  matcher: RelationalMatcher<Out, E, R>,
  node: Node,
  project: ProjectSnapshot,
  fileName: ProjectRelativePath,
): Effect.Effect<
  {
    readonly matched: boolean
    readonly facts?: Readonly<Record<string, EvidenceFact>> | undefined
  },
  E | ProjectSnapshotError,
  R
> => {
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
  if (matcher.mode === "node") {
    return Effect.map(matcher.match(node, project), (result) =>
      result.matched ? { matched: true, facts: result.facts } : { matched: false },
    )
  }
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

/**
 * Locate a node among its siblings. A node that is the sole child of an
 * ExpressionStatement is compared at statement granularity instead: its
 * siblings become the enclosing parent's children (for example, the
 * statements of a block). The positional fallback keeps the index stable
 * when traversal vends equal-range node instances rather than the same
 * object.
 */
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

  if (children.length === 1 && isExpressionStatement(parent) && parent.parent !== undefined) {
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

  const index = children.findIndex((c) => c === node || (c.pos === node.pos && c.end === node.end))
  if (index === -1) return undefined
  return { siblings: children, index }
}

/**
 * Evaluate a matcher against a sibling candidate. Relations are usually
 * authored at statement granularity (`foo(); other();`), so after a failed
 * direct match the candidate is retried through lone statement shells: an
 * ExpressionStatement or ReturnStatement candidate also matches via its
 * inner expression, which is then the reported node.
 */
const evaluateSibling = <Out, E, R>(
  matcher: RelationalMatcher<Out, E, R>,
  sibling: Node,
  project: ProjectSnapshot,
  fileName: ProjectRelativePath,
): Effect.Effect<
  {
    readonly matched: boolean
    readonly facts?: Readonly<Record<string, EvidenceFact>> | undefined
    readonly node: Node
  },
  E | ProjectSnapshotError,
  R
> =>
  Effect.gen(function* () {
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
  mode: "selection",
  id: `inside(${matcherId(matcher)})`,
  select: (selections) =>
    Effect.gen(function* () {
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
  mode: "selection",
  id: `has(${matcherId(matcher)})`,
  select: (selections) =>
    Effect.gen(function* () {
      const results: Array<Readonly<Record<string, EvidenceFact>> | undefined> = []
      for (const selection of selections) {
        let matchedFacts: Readonly<Record<string, EvidenceFact>> | undefined

        const search = (node: Node): Effect.Effect<void, E | ProjectSnapshotError, R> =>
          Effect.gen(function* () {
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

/**
 * Admit selections whose sibling in the given direction matches. `precedes`
 * scans following siblings; `follows` scans preceding ones. With
 * `immediately`, only the adjacent sibling is considered.
 */
const criterionSibling = <A extends Node, Out = unknown, E = never, R = never>(
  relation: "precedes" | "follows",
  matcher: RelationalMatcher<Out, E, R>,
  options?: SiblingOptions,
): Criterion<A, E | ProjectSnapshotError, R> => ({
  mode: "selection",
  id: `${relation}(${matcherId(matcher)})`,
  select: (selections) =>
    Effect.gen(function* () {
      const direction = relation === "precedes" ? 1 : -1
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
          const adjacent = siblings[index + direction]
          if (adjacent !== undefined) {
            const outcome = yield* evaluateSibling(
              matcher,
              adjacent,
              selection.project,
              selection.fileName,
            )
            if (outcome.matched) {
              matchedFacts = {
                siblingKind: SyntaxKind[outcome.node.kind] ?? String(outcome.node.kind),
                ...outcome.facts,
              }
            }
          }
        } else {
          for (let i = index + direction; i >= 0 && i < siblings.length; i += direction) {
            const sibling = siblings[i]!
            const outcome = yield* evaluateSibling(
              matcher,
              sibling,
              selection.project,
              selection.fileName,
            )
            if (outcome.matched) {
              matchedFacts = {
                siblingKind: SyntaxKind[outcome.node.kind] ?? String(outcome.node.kind),
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

/** Filter selections to only those nested inside an ancestor matching the given pattern, criterion, or predicate. */
export const inside =
  <Out = unknown, E2 = never, R2 = never>(
    matcher: RelationalMatcher<Out, E2, R2>,
    options?: InsideOptions,
  ) =>
  <A extends Node, E, R>(
    self: Query<A, E, R>,
  ): Query<A, E | E2 | ProjectSnapshotError | QueryContractError, R | R2> =>
    where(criterionInside<A, Out, E2, R2>(matcher, options))(self)

/** Filter selections to only those containing a descendant matching the given pattern, criterion, or predicate. */
export const has =
  <Out = unknown, E2 = never, R2 = never>(
    matcher: RelationalMatcher<Out, E2, R2>,
    options?: HasOptions,
  ) =>
  <A extends Node, E, R>(
    self: Query<A, E, R>,
  ): Query<A, E | E2 | ProjectSnapshotError | QueryContractError, R | R2> =>
    where(criterionHas<A, Out, E2, R2>(matcher, options))(self)

/** Filter selections to only those preceding a sibling matching the given pattern, criterion, or predicate. */
export const precedes =
  <Out = unknown, E2 = never, R2 = never>(
    matcher: RelationalMatcher<Out, E2, R2>,
    options?: SiblingOptions,
  ) =>
  <A extends Node, E, R>(
    self: Query<A, E, R>,
  ): Query<A, E | E2 | ProjectSnapshotError | QueryContractError, R | R2> =>
    where(criterionSibling<A, Out, E2, R2>("precedes", matcher, options))(self)

/** Filter selections to only those following a sibling matching the given pattern, criterion, or predicate. */
export const follows =
  <Out = unknown, E2 = never, R2 = never>(
    matcher: RelationalMatcher<Out, E2, R2>,
    options?: SiblingOptions,
  ) =>
  <A extends Node, E, R>(
    self: Query<A, E, R>,
  ): Query<A, E | E2 | ProjectSnapshotError | QueryContractError, R | R2> =>
    where(criterionSibling<A, Out, E2, R2>("follows", matcher, options))(self)

export const RelationCriterion = {
  inside: criterionInside,
  has: criterionHas,
  precedes: <A extends Node, Out = unknown, E = never, R = never>(
    matcher: RelationalMatcher<Out, E, R>,
    options?: SiblingOptions,
  ): Criterion<A, E | ProjectSnapshotError, R> => criterionSibling("precedes", matcher, options),
  follows: <A extends Node, Out = unknown, E = never, R = never>(
    matcher: RelationalMatcher<Out, E, R>,
    options?: SiblingOptions,
  ): Criterion<A, E | ProjectSnapshotError, R> => criterionSibling("follows", matcher, options),
}
