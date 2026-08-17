/** Matcher algebra and shared Pattern domain primitives. */
import { Effect } from "effect"
import type { Node, SyntaxKind } from "typescript/unstable/ast"
import { isCallExpression } from "typescript/unstable/ast/is"
import type { EvidenceFact } from "../Evidence/Core.ts"
import type { ProjectSnapshot, ProjectSnapshotError } from "../Workspace/index.ts"
import { matchFailure, matchSuccess } from "./Internal.ts"

export interface PatternMatchResult<Out> {
  readonly matched: true
  readonly value: Out
  readonly facts?: Readonly<Record<string, EvidenceFact>>
}
export interface PatternMismatch {
  readonly matched: false
}
export type PatternResult<Out> = PatternMatchResult<Out> | PatternMismatch

export type SyntaxKindFilter = SyntaxKind | ReadonlyArray<SyntaxKind>

/**
 * A node-level criterion. Query relations consume this same algebra as
 * selection-level criteria; the mode is explicit so relations never need to
 * inspect an arbitrary object to discover how it matches.
 */
export interface NodeCriterion<N extends Node = Node, Out = N> {
  readonly mode: "node"
  readonly kind?: string
  /** Optional traversal hint. It is a performance hint, not the full match. */
  readonly syntaxKind?: SyntaxKindFilter
  readonly match: (
    node: Node,
    project: ProjectSnapshot,
  ) => Effect.Effect<PatternResult<Out>, ProjectSnapshotError>
}

/** Backward-compatible name for node criteria. */
export type Pattern<N extends Node = Node, Out = N> = NodeCriterion<N, Out>

type Binding<K extends string, Out> = { readonly [P in K]: Out }
export type AnyPattern = Pattern<Node, unknown>
type TupleMatch<P extends ReadonlyArray<AnyPattern>> = {
  [K in keyof P]: P[K] extends Pattern<Node, infer Out> ? Out : never
}

/** Matches any node and yields it as-is. */
export const any: Pattern<Node, Node> = {
  mode: "node",
  kind: "any",
  match: (node) => Effect.succeed(matchSuccess(node)),
}

/** Matches a node against an arbitrary predicate. */
export const predicate = <N extends Node = Node, Out = N>(
  kind: string,
  test: (node: Node) => boolean | PatternResult<Out>,
  syntaxKind?: SyntaxKindFilter,
): Pattern<N, Out> => ({
  mode: "node",
  kind,
  ...(syntaxKind === undefined ? {} : { syntaxKind }),
  match: (node) =>
    Effect.sync(() => {
      const result = test(node)
      if (result === true) return matchSuccess(node as Out)
      return result === false ? matchFailure : result
    }),
})

export const not = <N extends Node, Out>(pattern: Pattern<N, Out>): Pattern<N, Node> => ({
  mode: "node",
  kind: `not(${pattern.kind ?? "pattern"})`,
  match: (node, project) =>
    pattern
      .match(node, project)
      .pipe(Effect.map((result) => (result.matched ? matchFailure : matchSuccess(node)))),
})

export const bind = <K extends string, N extends Node, Out>(
  key: K,
  pattern: Pattern<N, Out>,
): Pattern<N, Binding<K, Out>> => ({
  mode: "node",
  kind: `bind(${key})`,
  ...(pattern.syntaxKind === undefined ? {} : { syntaxKind: pattern.syntaxKind }),
  match: (node, project) =>
    pattern.match(node, project).pipe(
      Effect.map((result) => {
        if (!result.matched) return matchFailure
        const bound = { [key]: result.value } as Binding<K, Out>
        return matchSuccess(bound, result.facts)
      }),
    ),
})

/** Matches patterns against call arguments, or a singleton node. */
export const tuple = <P extends ReadonlyArray<AnyPattern>>(
  patterns: P,
): Pattern<Node, TupleMatch<P>> => ({
  mode: "node",
  kind: "tuple",
  match: (node, project) =>
    Effect.gen(function* () {
      const elements: ReadonlyArray<Node> = isCallExpression(node) ? node.arguments : [node]
      if (elements.length !== patterns.length) return matchFailure
      const values: Array<unknown> = []
      const facts = {} satisfies Record<string, EvidenceFact>
      for (let index = 0; index < patterns.length; index++) {
        const result = yield* patterns[index]!.match(elements[index]!, project)
        if (!result.matched) return matchFailure
        values.push(result.value)
        if (result.facts !== undefined) Object.assign(facts, result.facts)
      }
      return matchSuccess(values as TupleMatch<P>, facts)
    }),
})
