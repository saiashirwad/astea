import { Effect } from "effect"
import { SyntaxKind, type DoStatement, type ForInStatement, type ForOfStatement, type ForStatement, type IfStatement, type Node, type ReturnStatement, type TryStatement, type WhileStatement } from "typescript/unstable/ast"
import { isDoStatement, isForInStatement, isForOfStatement, isForStatement, isIfStatement, isReturnStatement, isTryStatement, isWhileStatement } from "typescript/unstable/ast/is"
import { predicate, type Pattern } from "./Core.ts"
import { matchFailure, matchSuccess } from "./Internal.ts"

export interface TryStatementPatternOptions { readonly hasCatch?: boolean; readonly hasFinally?: boolean }
export const tryStatement = (options?: TryStatementPatternOptions): Pattern<TryStatement, TryStatement> => ({ kind: "tryStatement", match: (node) => Effect.sync(() => {
  if (!isTryStatement(node) || (options?.hasCatch !== undefined && (node.catchClause !== undefined) !== options.hasCatch) || (options?.hasFinally !== undefined && (node.finallyBlock !== undefined) !== options.hasFinally)) return matchFailure
  return matchSuccess(node, { kind: SyntaxKind[node.kind] ?? node.kind, hasCatch: node.catchClause !== undefined, hasFinally: node.finallyBlock !== undefined })
}) })

export type LoopStatement = ForStatement | ForOfStatement | ForInStatement | WhileStatement | DoStatement
export interface LoopPatternOptions { readonly kind?: "for" | "for-of" | "for-in" | "while" | "do-while" }
const loopGuards = { "for": isForStatement, "for-of": isForOfStatement, "for-in": isForInStatement, "while": isWhileStatement, "do-while": isDoStatement } as const
export const loop = (options?: LoopPatternOptions): Pattern<LoopStatement, LoopStatement> => ({ kind: "loop", match: (node) => Effect.sync(() => {
  if (options?.kind !== undefined && !loopGuards[options.kind](node)) return matchFailure
  if (!isForStatement(node) && !isForOfStatement(node) && !isForInStatement(node) && !isWhileStatement(node) && !isDoStatement(node)) return matchFailure
  return matchSuccess(node, { loopKind: SyntaxKind[node.kind] ?? node.kind })
}) })
export const forStatement = (): Pattern<ForStatement, ForStatement> => predicate("forStatement", isForStatement)
export const forOfStatement = (): Pattern<ForOfStatement, ForOfStatement> => predicate("forOfStatement", isForOfStatement)
export const forInStatement = (): Pattern<ForInStatement, ForInStatement> => predicate("forInStatement", isForInStatement)
export const whileStatement = (): Pattern<WhileStatement, WhileStatement> => predicate("whileStatement", isWhileStatement)
export const doStatement = (): Pattern<DoStatement, DoStatement> => predicate("doStatement", isDoStatement)

export interface IfStatementPatternOptions { readonly hasElse?: boolean }
export const ifStatement = (options?: IfStatementPatternOptions): Pattern<IfStatement, IfStatement> => ({ kind: "ifStatement", match: (node) => Effect.sync(() => !isIfStatement(node) || (options?.hasElse !== undefined && (node.elseStatement !== undefined) !== options.hasElse) ? matchFailure : matchSuccess(node, { kind: SyntaxKind[node.kind] ?? node.kind, hasElse: node.elseStatement !== undefined })) })
export interface ReturnStatementPatternOptions<EOut = Node> { readonly expression?: Pattern<Node, EOut> }
export const returnStatement = <EOut = Node>(options?: ReturnStatementPatternOptions<EOut>): Pattern<ReturnStatement, ReturnStatement> => ({ kind: "returnStatement", match: (node, project) => Effect.gen(function*() {
  if (!isReturnStatement(node)) return matchFailure
  if (options?.expression !== undefined && (node.expression === undefined || !(yield* options.expression.match(node.expression, project)).matched)) return matchFailure
  return matchSuccess(node, { kind: SyntaxKind[node.kind] ?? node.kind })
}) })
