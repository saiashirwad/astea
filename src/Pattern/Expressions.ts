import { Effect } from "effect"
import {
  SyntaxKind,
  type AwaitExpression,
  type CallExpression,
  type Identifier,
  type Node,
  type NoSubstitutionTemplateLiteral,
  type NumericLiteral,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type StringLiteral,
  type TemplateExpression,
} from "typescript/unstable/ast"
import {
  isAwaitExpression,
  isCallExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  isTemplateExpression,
} from "typescript/unstable/ast/is"
import type { Symbol as NativeSymbol } from "typescript/unstable/async"
import type { EvidenceFact } from "../Evidence/Evidence.ts"
import {
  matchFailure,
  matchSuccess,
  matchesName,
  predicate,
  tuple,
  type AnyPattern,
  type Pattern,
} from "./Pattern.ts"

export const identifier = (options?: {
  readonly name?: string | RegExp
  readonly resolvesTo?: NativeSymbol
}): Pattern<Identifier, Identifier> => ({
  mode: "node",
  kind: "identifier",
  syntaxKind: SyntaxKind.Identifier,
  match: (node, project) =>
    Effect.gen(function* () {
      if (
        !isIdentifier(node) ||
        (options?.name !== undefined && !matchesName(options.name, node.text))
      )
        return matchFailure
      if (options?.resolvesTo !== undefined) {
        const symbol = yield* project.symbolAt(
          node.getSourceFile().fileName,
          node.getStart(node.getSourceFile()),
        )
        if (symbol === undefined) return matchFailure
        const canonical = yield* project.canonicalSymbol(symbol)
        if (canonical !== options.resolvesTo) return matchFailure
      }
      return matchSuccess(node, { identifier: node.text })
    }),
})

export interface CallExpressionMatch<EOut, AOut> {
  readonly call: CallExpression
  readonly expression: EOut
  readonly args: AOut
}
const isPattern = <Out>(
  value: Pattern<Node, Out> | ReadonlyArray<AnyPattern>,
): value is Pattern<Node, Out> => !Array.isArray(value)
export const callExpression = <EOut = Node, AOut = ReadonlyArray<Node>>(options?: {
  readonly expression?: Pattern<Node, EOut>
  readonly arguments?: Pattern<Node, AOut> | ReadonlyArray<AnyPattern>
}): Pattern<CallExpression, CallExpressionMatch<EOut, AOut>> => {
  const argumentPattern =
    options?.arguments === undefined
      ? undefined
      : isPattern(options.arguments)
        ? options.arguments
        : tuple(options.arguments)

  return {
    mode: "node",
    kind: "callExpression",
    syntaxKind: SyntaxKind.CallExpression,
    match: (node, project) =>
      Effect.gen(function* () {
        if (!isCallExpression(node)) return matchFailure
        const facts = { kind: SyntaxKind[node.kind] ?? node.kind } satisfies Record<
          string,
          EvidenceFact
        >
        // SAFETY: the caller's expression pattern constrains this output type.
        let expression = node.expression as EOut
        if (options?.expression !== undefined) {
          const result = yield* options.expression.match(node.expression, project)
          if (!result.matched) return matchFailure
          expression = result.value
          if (result.facts !== undefined) Object.assign(facts, result.facts)
        }
        // SAFETY: the caller's argument pattern constrains this output type.
        let args = node.arguments as AOut
        if (argumentPattern !== undefined) {
          const result = yield* argumentPattern.match(node, project)
          if (!result.matched) return matchFailure
          // SAFETY: argumentPattern was constructed from the caller's AOut pattern.
          args = result.value as AOut
          if (result.facts !== undefined) Object.assign(facts, result.facts)
        }
        return matchSuccess({ call: node, expression, args }, facts)
      }),
  }
}

export const propertyAccess = (options?: {
  readonly expression?: Pattern<Node, unknown>
  readonly name?: string | RegExp
}): Pattern<PropertyAccessExpression, PropertyAccessExpression> => ({
  mode: "node",
  kind: "propertyAccess",
  syntaxKind: SyntaxKind.PropertyAccessExpression,
  match: (node, project) =>
    Effect.gen(function* () {
      if (
        !isPropertyAccessExpression(node) ||
        (options?.name !== undefined && !matchesName(options.name, node.name.text))
      )
        return matchFailure
      if (
        options?.expression !== undefined &&
        !(yield* options.expression.match(node.expression, project)).matched
      )
        return matchFailure
      return matchSuccess(node, { property: node.name.text })
    }),
})

export const stringLiteral = (options?: {
  readonly text?: string | RegExp
}): Pattern<StringLiteral, StringLiteral> => ({
  mode: "node",
  kind: "stringLiteral",
  syntaxKind: SyntaxKind.StringLiteral,
  match: (node) =>
    Effect.sync(() =>
      !isStringLiteral(node) ||
      (options?.text !== undefined && !matchesName(options.text, node.text))
        ? matchFailure
        : matchSuccess(node, { text: node.text }),
    ),
})
export const numericLiteral = (options?: {
  readonly value?: number
}): Pattern<NumericLiteral, NumericLiteral> => ({
  mode: "node",
  kind: "numericLiteral",
  syntaxKind: SyntaxKind.NumericLiteral,
  match: (node) =>
    Effect.sync(() =>
      !isNumericLiteral(node) ||
      (options?.value !== undefined && Number(node.text) !== options.value)
        ? matchFailure
        : matchSuccess(node, { value: Number(node.text) }),
    ),
})
export const objectLiteral = (options?: {
  readonly hasProperties?: ReadonlyArray<string>
}): Pattern<ObjectLiteralExpression, ObjectLiteralExpression> => ({
  mode: "node",
  kind: "objectLiteral",
  syntaxKind: SyntaxKind.ObjectLiteralExpression,
  match: (node) =>
    Effect.sync(() => {
      if (!isObjectLiteralExpression(node)) return matchFailure
      if (options?.hasProperties !== undefined) {
        const names = new Set(
          node.properties
            .filter(isPropertyAssignment)
            .map((p) => (isIdentifier(p.name) || isStringLiteral(p.name) ? p.name.text : "")),
        )
        if (!options.hasProperties.every((name) => names.has(name))) {
          return matchFailure
        }
      }
      return matchSuccess(node, { propertyCount: node.properties.length })
    }),
})

export type StringLike = StringLiteral | NoSubstitutionTemplateLiteral | TemplateExpression
export const isStringLike = (node: Node): node is StringLike =>
  isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) || isTemplateExpression(node)
export const stringLike = (): Pattern<Node, StringLike> =>
  predicate<Node, StringLike>("string-like", isStringLike, [
    SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.TemplateExpression,
  ])
export interface AwaitExpressionPatternOptions {
  readonly expression?: Pattern<Node, unknown>
}
export const awaitExpression = (
  options?: AwaitExpressionPatternOptions,
): Pattern<AwaitExpression, AwaitExpression> => ({
  mode: "node",
  kind: "awaitExpression",
  syntaxKind: SyntaxKind.AwaitExpression,
  match: (node, project) =>
    Effect.gen(function* () {
      if (!isAwaitExpression(node)) return matchFailure
      if (
        options?.expression !== undefined &&
        !(yield* options.expression.match(node.expression, project)).matched
      )
        return matchFailure
      return matchSuccess(node, { kind: SyntaxKind[node.kind] ?? node.kind })
    }),
})
