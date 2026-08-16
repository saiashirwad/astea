/**
 * Candidate public API — Declarative AST Pattern Matcher.
 *
 * A Pattern is a declarative, composable matcher over native TypeScript AST nodes.
 * It matches structural syntax and semantic criteria (symbols, types) while extracting
 * strongly typed bindings and producing deterministic query evidence.
 */
import { Effect } from "effect"
import {
  type CallExpression,
  type Identifier,
  type Node,
  type NumericLiteral,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type StringLiteral,
  SyntaxKind,
} from "typescript/unstable/ast"
import {
  isCallExpression,
  isIdentifier,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
} from "typescript/unstable/ast/is"
import { SymbolFlags, type Symbol as NativeSymbol } from "typescript/unstable/async"
import { nativeRequest } from "../prototype/native-compiler.ts"
import type { EvidenceFact } from "./query.ts"
import type { ProjectSnapshot, ProjectSnapshotError } from "./workspace.ts"

export interface PatternMatchResult<Out> {
  readonly matched: true
  readonly value: Out
  readonly facts?: Record<string, EvidenceFact>
}

export interface PatternMismatch {
  readonly matched: false
}

export type PatternResult<Out> = PatternMatchResult<Out> | PatternMismatch

export interface Pattern<N extends Node = Node, Out = N> {
  readonly kind?: string
  readonly match: (
    node: Node,
    project: ProjectSnapshot,
  ) => Effect.Effect<PatternResult<Out>, ProjectSnapshotError>
}

const matchSuccess = <Out>(
  value: Out,
  facts?: Record<string, EvidenceFact>,
): PatternResult<Out> => ({
  matched: true,
  value,
  ...(facts !== undefined ? { facts } : {}),
})

const matchFailure: PatternMismatch = { matched: false }

/** Matches any node and yields it as-is. */
export const any: Pattern<Node, Node> = {
  kind: "any",
  match: (node) => Effect.succeed(matchSuccess(node)),
}

/** Matches a node against an arbitrary predicate. */
export const predicate = <N extends Node = Node, Out = N>(
  kind: string,
  test: (node: Node) => boolean | PatternResult<Out>,
): Pattern<N, Out> => ({
  kind,
  match: (node) =>
    Effect.sync(() => {
      const result = test(node)
      if (typeof result === "boolean") {
        return result ? matchSuccess(node as unknown as Out) : matchFailure
      }
      return result
    }),
})

/** Inverts a pattern match. */
export const not = <N extends Node, Out>(
  pattern: Pattern<N, Out>,
): Pattern<N, Node> => ({
  kind: `not(${pattern.kind ?? "pattern"})`,
  match: (node, project) =>
    pattern.match(node, project).pipe(
      Effect.map((res) => (res.matched ? matchFailure : matchSuccess(node))),
    ),
})

/** Binds the matched node to a named key in an output object. */
export const bind = <K extends string, N extends Node, Out>(
  key: K,
  pattern: Pattern<N, Out>,
): Pattern<N, { readonly [P in K]: Out }> => ({
  kind: `bind(${key})`,
  match: (node, project) =>
    pattern.match(node, project).pipe(
      Effect.map((res) =>
        res.matched
          ? matchSuccess({ [key]: res.value } as { readonly [P in K]: Out }, res.facts)
          : matchFailure
      ),
    ),
})

/** Matches an array of patterns against an array of nodes (e.g. call arguments). */
export const tuple = <P extends ReadonlyArray<Pattern<any, any>>>(
  patterns: P,
): Pattern<Node, { [K in keyof P]: P[K] extends Pattern<any, infer Out> ? Out : never }> => ({
  kind: "tuple",
  match: (node, project) =>
    Effect.gen(function*() {
      // If node is an array-like container or if evaluating child nodes
      const elements: ReadonlyArray<Node> = isCallExpression(node)
        ? node.arguments
        : (Array.isArray(node) ? node : [node])

      if (elements.length !== patterns.length) return matchFailure

      const values: Array<any> = []
      const facts: Record<string, EvidenceFact> = {}

      for (let i = 0; i < patterns.length; i++) {
        const pattern = patterns[i]!
        const elem = elements[i]!
        const result = yield* pattern.match(elem, project)
        if (!result.matched) return matchFailure
        values.push(result.value)
        if (result.facts) Object.assign(facts, result.facts)
      }

      return matchSuccess(values as any, facts)
    }),
})

/** Matches an Identifier node, optionally filtering by name or canonical symbol. */
export const identifier = (options?: {
  readonly name?: string | RegExp
  readonly resolvesTo?: NativeSymbol
}): Pattern<Identifier, Identifier> => ({
  kind: "identifier",
  match: (node, project) =>
    Effect.gen(function*() {
      if (!isIdentifier(node)) return matchFailure
      if (options?.name !== undefined) {
        const nameMatches = typeof options.name === "string"
          ? node.text === options.name
          : options.name.test(node.text)
        if (!nameMatches) return matchFailure
      }
      if (options?.resolvesTo !== undefined) {
        const expectedSymbol = options.resolvesTo
        const sourceFile = node.getSourceFile()
        const position = node.getStart(sourceFile)
        const symbol = yield* project.symbolAt(sourceFile.fileName, position)
        if (symbol === undefined) return matchFailure

        const canonical = yield* project.unsafeNative((nativeProject) =>
          (symbol.flags & SymbolFlags.Alias) === 0
            ? Effect.succeed(symbol)
            : nativeRequest("getAliasedSymbol", () => nativeProject.checker.getAliasedSymbol(symbol))
        )
        if (canonical !== expectedSymbol) return matchFailure
      }
      return matchSuccess(node, { identifier: node.text })
    }),
})

/** Matches a CallExpression node, optionally verifying expression pattern and arguments. */
export const callExpression = <EOut = Node, AOut = ReadonlyArray<Node>>(options?: {
  readonly expression?: Pattern<any, EOut>
  readonly arguments?: Pattern<any, AOut> | ReadonlyArray<Pattern<any, any>>
}): Pattern<CallExpression, { readonly call: CallExpression; readonly expression: EOut; readonly args: AOut }> => ({
  kind: "callExpression",
  match: (node, project) =>
    Effect.gen(function*() {
      if (!isCallExpression(node)) return matchFailure
      const facts: Record<string, EvidenceFact> = {
        kind: SyntaxKind[node.kind] ?? node.kind,
      }

      let expressionVal: any = node.expression
      if (options?.expression !== undefined) {
        const expRes = yield* options.expression.match(node.expression, project)
        if (!expRes.matched) return matchFailure
        expressionVal = expRes.value
        if (expRes.facts) Object.assign(facts, expRes.facts)
      }

      let argsVal: any = node.arguments
      if (options?.arguments !== undefined) {
        const argPattern: Pattern<any, any> = Array.isArray(options.arguments)
          ? tuple(options.arguments)
          : (options.arguments as Pattern<any, any>)

        const argsRes = yield* argPattern.match(node, project)
        if (!argsRes.matched) return matchFailure
        argsVal = argsRes.value
        if (argsRes.facts) Object.assign(facts, argsRes.facts)
      }

      return matchSuccess(
        { call: node, expression: expressionVal, args: argsVal },
        facts,
      )
    }),
})

/** Matches a PropertyAccessExpression node (e.g. `obj.prop`). */
export const propertyAccess = (options?: {
  readonly expression?: Pattern<any, any>
  readonly name?: string | RegExp
}): Pattern<PropertyAccessExpression, PropertyAccessExpression> => ({
  kind: "propertyAccess",
  match: (node, project) =>
    Effect.gen(function*() {
      if (!isPropertyAccessExpression(node)) return matchFailure
      if (options?.name !== undefined) {
        const nameMatches = typeof options.name === "string"
          ? node.name.text === options.name
          : options.name.test(node.name.text)
        if (!nameMatches) return matchFailure
      }
      if (options?.expression !== undefined) {
        const expRes = yield* options.expression.match(node.expression, project)
        if (!expRes.matched) return matchFailure
      }
      return matchSuccess(node, { property: node.name.text })
    }),
})

/** Matches a StringLiteral node. */
export const stringLiteral = (options?: {
  readonly text?: string | RegExp
}): Pattern<StringLiteral, StringLiteral> => ({
  kind: "stringLiteral",
  match: (node) =>
    Effect.sync(() => {
      if (!isStringLiteral(node)) return matchFailure
      if (options?.text !== undefined) {
        const matches = typeof options.text === "string"
          ? node.text === options.text
          : options.text.test(node.text)
        if (!matches) return matchFailure
      }
      return matchSuccess(node, { text: node.text })
    }),
})

/** Matches a NumericLiteral node. */
export const numericLiteral = (options?: {
  readonly value?: number
}): Pattern<NumericLiteral, NumericLiteral> => ({
  kind: "numericLiteral",
  match: (node) =>
    Effect.sync(() => {
      if (!isNumericLiteral(node)) return matchFailure
      const val = Number(node.text)
      if (options?.value !== undefined && val !== options.value) return matchFailure
      return matchSuccess(node, { value: val })
    }),
})

/** Matches an ObjectLiteralExpression node. */
export const objectLiteral = (options?: {
  readonly hasProperties?: ReadonlyArray<string>
}): Pattern<ObjectLiteralExpression, ObjectLiteralExpression> => ({
  kind: "objectLiteral",
  match: (node) =>
    Effect.sync(() => {
      if (!isObjectLiteralExpression(node)) return matchFailure
      if (options?.hasProperties !== undefined) {
        const propNames = new Set(
          node.properties
            .filter(isPropertyAssignment)
            .map((p) => (isIdentifier(p.name) || isStringLiteral(p.name) ? p.name.text : "")),
        )
        const hasAll = options.hasProperties.every((p) => propNames.has(p))
        if (!hasAll) return matchFailure
      }
      return matchSuccess(node, { propertyCount: node.properties.length })
    }),
})

export const Pattern = {
  any,
  predicate,
  not,
  bind,
  tuple,
  identifier,
  callExpression,
  propertyAccess,
  stringLiteral,
  numericLiteral,
  objectLiteral,
}
