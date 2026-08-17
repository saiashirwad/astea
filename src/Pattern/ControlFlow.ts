import { Effect } from "effect"
import {
  SyntaxKind,
  type DoStatement,
  type ForInStatement,
  type ForOfStatement,
  type ForStatement,
  type IfStatement,
  type Node,
  type ReturnStatement,
  type TryStatement,
  type WhileStatement,
} from "typescript/unstable/ast"
import {
  isDoStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIfStatement,
  isReturnStatement,
  isTryStatement,
  isWhileStatement,
} from "typescript/unstable/ast/is"
import { predicate, type Pattern } from "./Core.ts"
import { matchFailure, matchSuccess } from "./Internal.ts"

export interface TryStatementPatternOptions {
  readonly hasCatch?: boolean
  readonly hasFinally?: boolean
}
export const tryStatement = (
  options?: TryStatementPatternOptions,
): Pattern<TryStatement, TryStatement> => ({
  mode: "node",
  kind: "tryStatement",
  syntaxKind: SyntaxKind.TryStatement,
  match: (node) =>
    Effect.sync(() => {
      if (
        !isTryStatement(node) ||
        (options?.hasCatch !== undefined &&
          (node.catchClause !== undefined) !== options.hasCatch) ||
        (options?.hasFinally !== undefined &&
          (node.finallyBlock !== undefined) !== options.hasFinally)
      )
        return matchFailure
      return matchSuccess(node, {
        kind: SyntaxKind[node.kind] ?? node.kind,
        hasCatch: node.catchClause !== undefined,
        hasFinally: node.finallyBlock !== undefined,
      })
    }),
})

export type LoopStatement =
  | ForStatement
  | ForOfStatement
  | ForInStatement
  | WhileStatement
  | DoStatement
export interface LoopPatternOptions {
  readonly kind?: "for" | "for-of" | "for-in" | "while" | "do-while"
}
const loopGuards = {
  for: isForStatement,
  "for-of": isForOfStatement,
  "for-in": isForInStatement,
  while: isWhileStatement,
  "do-while": isDoStatement,
} as const
export const loop = (options?: LoopPatternOptions): Pattern<LoopStatement, LoopStatement> => ({
  mode: "node",
  kind: "loop",
  syntaxKind: [
    SyntaxKind.ForStatement,
    SyntaxKind.ForOfStatement,
    SyntaxKind.ForInStatement,
    SyntaxKind.WhileStatement,
    SyntaxKind.DoStatement,
  ],
  match: (node) =>
    Effect.sync(() => {
      if (options?.kind !== undefined && !loopGuards[options.kind](node)) return matchFailure
      if (
        !isForStatement(node) &&
        !isForOfStatement(node) &&
        !isForInStatement(node) &&
        !isWhileStatement(node) &&
        !isDoStatement(node)
      )
        return matchFailure
      return matchSuccess(node, { loopKind: SyntaxKind[node.kind] ?? node.kind })
    }),
})
export const forStatement = (): Pattern<ForStatement, ForStatement> =>
  predicate("forStatement", isForStatement, SyntaxKind.ForStatement)
export const forOfStatement = (): Pattern<ForOfStatement, ForOfStatement> =>
  predicate("forOfStatement", isForOfStatement, SyntaxKind.ForOfStatement)
export const forInStatement = (): Pattern<ForInStatement, ForInStatement> =>
  predicate("forInStatement", isForInStatement, SyntaxKind.ForInStatement)
export const whileStatement = (): Pattern<WhileStatement, WhileStatement> =>
  predicate("whileStatement", isWhileStatement, SyntaxKind.WhileStatement)
export const doStatement = (): Pattern<DoStatement, DoStatement> =>
  predicate("doStatement", isDoStatement, SyntaxKind.DoStatement)

export interface IfStatementPatternOptions {
  readonly hasElse?: boolean
}
export const ifStatement = (
  options?: IfStatementPatternOptions,
): Pattern<IfStatement, IfStatement> => ({
  mode: "node",
  kind: "ifStatement",
  syntaxKind: SyntaxKind.IfStatement,
  match: (node) =>
    Effect.sync(() =>
      !isIfStatement(node) ||
      (options?.hasElse !== undefined && (node.elseStatement !== undefined) !== options.hasElse)
        ? matchFailure
        : matchSuccess(node, {
            kind: SyntaxKind[node.kind] ?? node.kind,
            hasElse: node.elseStatement !== undefined,
          }),
    ),
})
export interface ReturnStatementPatternOptions<EOut = Node> {
  readonly expression?: Pattern<Node, EOut>
}
export const returnStatement = <EOut = Node>(
  options?: ReturnStatementPatternOptions<EOut>,
): Pattern<ReturnStatement, ReturnStatement> => ({
  mode: "node",
  kind: "returnStatement",
  syntaxKind: SyntaxKind.ReturnStatement,
  match: (node, project) =>
    Effect.gen(function* () {
      if (!isReturnStatement(node)) return matchFailure
      if (
        options?.expression !== undefined &&
        (node.expression === undefined ||
          !(yield* options.expression.match(node.expression, project)).matched)
      )
        return matchFailure
      return matchSuccess(node, { kind: SyntaxKind[node.kind] ?? node.kind })
    }),
})
