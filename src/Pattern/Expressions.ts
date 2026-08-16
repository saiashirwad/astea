import { Effect } from "effect"
import { SyntaxKind, type AwaitExpression, type CallExpression, type Identifier, type Node, type NoSubstitutionTemplateLiteral, type NumericLiteral, type ObjectLiteralExpression, type PropertyAccessExpression, type StringLiteral, type TemplateExpression } from "typescript/unstable/ast"
import { isAwaitExpression, isCallExpression, isIdentifier, isNoSubstitutionTemplateLiteral, isNumericLiteral, isObjectLiteralExpression, isPropertyAccessExpression, isPropertyAssignment, isStringLiteral, isTemplateExpression } from "typescript/unstable/ast/is"
import { SymbolFlags, type Symbol as NativeSymbol } from "typescript/unstable/async"
import { nativeRequest } from "../Compiler/Service.ts"
import type { EvidenceFact } from "../Evidence/Model.ts"
import { tuple, predicate, type AnyPattern, type Pattern } from "./Core.ts"
import { matchFailure, matchSuccess, matchesName } from "./Internal.ts"

export const identifier = (options?: { readonly name?: string | RegExp; readonly resolvesTo?: NativeSymbol }): Pattern<Identifier, Identifier> => ({
  kind: "identifier",
  match: (node, project) => Effect.gen(function*() {
    if (!isIdentifier(node) || (options?.name !== undefined && !matchesName(options.name, node.text))) return matchFailure
    if (options?.resolvesTo !== undefined) {
      const symbol = yield* project.symbolAt(node.getSourceFile().fileName, node.getStart(node.getSourceFile()))
      if (symbol === undefined) return matchFailure
      const canonical = yield* project.unsafeNative((nativeProject) => (symbol.flags & SymbolFlags.Alias) === 0
        ? Effect.succeed(symbol)
        : nativeRequest("getAliasedSymbol", () => nativeProject.checker.getAliasedSymbol(symbol)))
      if (canonical !== options.resolvesTo) return matchFailure
    }
    return matchSuccess(node, { identifier: node.text })
  }),
})

export interface CallExpressionMatch<EOut, AOut> { readonly call: CallExpression; readonly expression: EOut; readonly args: AOut }
const isPattern = <Out>(value: Pattern<Node, Out> | ReadonlyArray<AnyPattern>): value is Pattern<Node, Out> => "match" in value
export const callExpression = <EOut = Node, AOut = ReadonlyArray<Node>>(options?: {
  readonly expression?: Pattern<Node, EOut>
  readonly arguments?: Pattern<Node, AOut> | ReadonlyArray<AnyPattern>
}): Pattern<CallExpression, CallExpressionMatch<EOut, AOut>> => ({
  kind: "callExpression",
  match: (node, project) => Effect.gen(function*() {
    if (!isCallExpression(node)) return matchFailure
    const facts = { kind: SyntaxKind[node.kind] ?? node.kind } satisfies Record<string, EvidenceFact>
    let expression = node.expression as EOut
    if (options?.expression !== undefined) {
      const result = yield* options.expression.match(node.expression, project)
      if (!result.matched) return matchFailure
      expression = result.value
      if (result.facts !== undefined) Object.assign(facts, result.facts)
    }
    let args = node.arguments as AOut
    if (options?.arguments !== undefined) {
      const argumentPattern = isPattern(options.arguments) ? options.arguments : tuple(options.arguments)
      const result = yield* argumentPattern.match(node, project)
      if (!result.matched) return matchFailure
      args = result.value as AOut
      if (result.facts !== undefined) Object.assign(facts, result.facts)
    }
    return matchSuccess({ call: node, expression, args }, facts)
  }),
})

export const propertyAccess = (options?: { readonly expression?: Pattern<Node, unknown>; readonly name?: string | RegExp }): Pattern<PropertyAccessExpression, PropertyAccessExpression> => ({
  kind: "propertyAccess",
  match: (node, project) => Effect.gen(function*() {
    if (!isPropertyAccessExpression(node) || (options?.name !== undefined && !matchesName(options.name, node.name.text))) return matchFailure
    if (options?.expression !== undefined && !(yield* options.expression.match(node.expression, project)).matched) return matchFailure
    return matchSuccess(node, { property: node.name.text })
  }),
})

export const stringLiteral = (options?: { readonly text?: string | RegExp }): Pattern<StringLiteral, StringLiteral> => ({ kind: "stringLiteral", match: (node) => Effect.sync(() => !isStringLiteral(node) || (options?.text !== undefined && !matchesName(options.text, node.text)) ? matchFailure : matchSuccess(node, { text: node.text })) })
export const numericLiteral = (options?: { readonly value?: number }): Pattern<NumericLiteral, NumericLiteral> => ({ kind: "numericLiteral", match: (node) => Effect.sync(() => !isNumericLiteral(node) || (options?.value !== undefined && Number(node.text) !== options.value) ? matchFailure : matchSuccess(node, { value: Number(node.text) })) })
export const objectLiteral = (options?: { readonly hasProperties?: ReadonlyArray<string> }): Pattern<ObjectLiteralExpression, ObjectLiteralExpression> => ({
  kind: "objectLiteral", match: (node) => Effect.sync(() => {
    if (!isObjectLiteralExpression(node)) return matchFailure
    const names = new Set(node.properties.filter(isPropertyAssignment).map((p) => isIdentifier(p.name) || isStringLiteral(p.name) ? p.name.text : ""))
    return options?.hasProperties?.every((name) => names.has(name)) === false ? matchFailure : matchSuccess(node, { propertyCount: node.properties.length })
  }),
})

export type StringLike = StringLiteral | NoSubstitutionTemplateLiteral | TemplateExpression
export const isStringLike = (node: Node): node is StringLike => isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) || isTemplateExpression(node)
export const stringLike = (): Pattern<Node, StringLike> => predicate<Node, StringLike>("string-like", isStringLike)
export interface AwaitExpressionPatternOptions<EOut = Node> { readonly expression?: Pattern<Node, EOut> }
export const awaitExpression = <EOut = Node>(options?: AwaitExpressionPatternOptions<EOut>): Pattern<AwaitExpression, AwaitExpression> => ({
  kind: "awaitExpression", match: (node, project) => Effect.gen(function*() {
    if (!isAwaitExpression(node)) return matchFailure
    if (options?.expression !== undefined && !(yield* options.expression.match(node.expression, project)).matched) return matchFailure
    return matchSuccess(node, { kind: SyntaxKind[node.kind] ?? node.kind })
  }),
})
