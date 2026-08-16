/**
 * Candidate public API — Declarative AST Pattern Matcher.
 *
 * A Pattern is a declarative, composable matcher over native TypeScript AST nodes.
 * It matches structural syntax and semantic criteria (symbols, types) while extracting
 * strongly typed bindings and producing deterministic query evidence.
 */
import { Effect, Predicate } from "effect"
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
import { SymbolFlags, type Symbol as NativeSymbol, type Type as NativeType } from "typescript/unstable/async"
import { nativeRequest } from "../internal/native-compiler.ts"
import { projectRelativePath } from "../internal/project-path.ts"
import type { EvidenceFact } from "./query.ts"
import type { ProjectSnapshot, ProjectSnapshotError } from "./workspace.ts"

export interface PatternMatchResult<Out> {
  readonly matched: true
  readonly value: Out
  readonly facts?: Readonly<Record<string, EvidenceFact>>
}

export interface PatternMismatch {
  readonly matched: false
}

export type PatternResult<Out> = PatternMatchResult<Out> | PatternMismatch

const isPattern = <Out>(
  value: Pattern<Node, Out> | ReadonlyArray<AnyPattern>,
): value is Pattern<Node, Out> => "match" in value

export interface Pattern<N extends Node = Node, Out = N> {
  readonly kind?: string
  readonly match: (
    node: Node,
    project: ProjectSnapshot,
  ) => Effect.Effect<PatternResult<Out>, ProjectSnapshotError>
}

const matchSuccess = <Out>(
  value: Out,
  facts?: Readonly<Record<string, EvidenceFact>>,
): PatternResult<Out> => {
  if (facts === undefined) {
    return { matched: true, value }
  }
  return { matched: true, value, facts }
}

const matchFailure: PatternMismatch = { matched: false }

type NameMatcher = { readonly kind: "exact"; readonly value: string } | { readonly kind: "regex"; readonly value: RegExp }

const nameMatcher = (name: string | RegExp): NameMatcher =>
  name instanceof RegExp ? { kind: "regex", value: name } : { kind: "exact", value: name }

const matchesName = (matcher: NameMatcher, text: string): boolean =>
  matcher.kind === "exact" ? text === matcher.value : matcher.value.test(text)

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
      if (result === true) {
        // SAFETY: predicate authors return true only when `node` is a valid Out
        const out = node as unknown as Out
        return matchSuccess(out)
      }
      if (result === false) return matchFailure
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
      Effect.map((res) => {
        if (!res.matched) return matchFailure
        const bound = { [key]: res.value } as { readonly [P in K]: Out }
        // SAFETY: computed key K is preserved by the mapped object construction above
        return matchSuccess(bound, res.facts)
      }),
    ),
})

type AnyPattern = Pattern<Node, unknown>

/** Matches an array of patterns against an array of nodes (e.g. call arguments). */
export const tuple = <P extends ReadonlyArray<AnyPattern>>(
  patterns: P,
): Pattern<Node, { [K in keyof P]: P[K] extends Pattern<Node, infer Out> ? Out : never }> => ({
  kind: "tuple",
  match: (node, project) =>
    Effect.gen(function*() {
      const elements: ReadonlyArray<Node> = isCallExpression(node)
        ? node.arguments
        : [node]

      if (elements.length !== patterns.length) return matchFailure

      const values: Array<unknown> = []
      const facts: Record<string, EvidenceFact> = {}

      for (let i = 0; i < patterns.length; i++) {
        const pattern = patterns[i]!
        const elem = elements[i]!
        const result = yield* pattern.match(elem, project)
        if (!result.matched) return matchFailure
        values.push(result.value)
        if (result.facts !== undefined) Object.assign(facts, result.facts)
      }

      // SAFETY: values length and order match the pattern tuple contract
      return matchSuccess(
        values as { [K in keyof P]: P[K] extends Pattern<Node, infer Out> ? Out : never },
        facts,
      )
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
        if (!matchesName(nameMatcher(options.name), node.text)) return matchFailure
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

export interface CallExpressionMatch<EOut, AOut> {
  readonly call: CallExpression
  readonly expression: EOut
  readonly args: AOut
}

/** Matches a CallExpression node, optionally verifying expression pattern and arguments. */
export const callExpression = <EOut = Node, AOut = ReadonlyArray<Node>>(options?: {
  readonly expression?: Pattern<Node, EOut>
  readonly arguments?: Pattern<Node, AOut> | ReadonlyArray<AnyPattern>
}): Pattern<CallExpression, CallExpressionMatch<EOut, AOut>> => ({
  kind: "callExpression",
  match: (node, project) =>
    Effect.gen(function*() {
      if (!isCallExpression(node)) return matchFailure
      const facts: Record<string, EvidenceFact> = {
        kind: SyntaxKind[node.kind] ?? node.kind,
      }

      let expressionVal: EOut = node.expression as EOut
      if (options?.expression !== undefined) {
        const expRes = yield* options.expression.match(node.expression, project)
        if (!expRes.matched) return matchFailure
        expressionVal = expRes.value
        if (expRes.facts !== undefined) Object.assign(facts, expRes.facts)
      }

      let argsVal: AOut = node.arguments as AOut
      if (options?.arguments !== undefined) {
        const argumentPatterns = options.arguments
        if (!isPattern(argumentPatterns)) {
          const argsRes = yield* tuple(argumentPatterns).match(node, project)
          if (!argsRes.matched) return matchFailure
          // SAFETY: the generic tuple output is the caller-selected AOut for this overload.
          argsVal = argsRes.value as AOut
          if (argsRes.facts !== undefined) Object.assign(facts, argsRes.facts)
          return matchSuccess(
            { call: node, expression: expressionVal, args: argsVal },
            facts,
          )
        }

        const argsRes = yield* argumentPatterns.match(node, project)
        if (!argsRes.matched) return matchFailure
        argsVal = argsRes.value
        if (argsRes.facts !== undefined) Object.assign(facts, argsRes.facts)
      }

      return matchSuccess(
        { call: node, expression: expressionVal, args: argsVal },
        facts,
      )
    }),
})

/** Matches a PropertyAccessExpression node (e.g. `obj.prop`). */
export const propertyAccess = (options?: {
  readonly expression?: Pattern<Node, unknown>
  readonly name?: string | RegExp
}): Pattern<PropertyAccessExpression, PropertyAccessExpression> => ({
  kind: "propertyAccess",
  match: (node, project) =>
    Effect.gen(function*() {
      if (!isPropertyAccessExpression(node)) return matchFailure
      if (options?.name !== undefined) {
        if (!matchesName(nameMatcher(options.name), node.name.text)) return matchFailure
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
        if (!matchesName(nameMatcher(options.text), node.text)) return matchFailure
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

export type IntrinsicTypeName = "string" | "number" | "boolean" | "any" | "unknown" | "never" | "void"

const isIntrinsicTypeName = (value: NativeType | IntrinsicTypeName): value is IntrinsicTypeName =>
  Predicate.isString(value)

/** Matches a node based on its inferred TypeScript type. */
export const typed = (options?: {
  readonly assignableTo?: NativeType | IntrinsicTypeName
  readonly typeString?: string | RegExp
}): Pattern<Node, Node> => ({
  kind: "typed",
  match: (node, project) =>
    Effect.gen(function*() {
      const sourceFile = node.getSourceFile()
      const pos = node.getStart(sourceFile)
      const fileName = projectRelativePath(project.root, sourceFile.fileName)
      const type = yield* project.typeAt(fileName, pos)
      if (type === undefined) return matchFailure

      if (options?.typeString !== undefined) {
        const str = yield* project.typeToString(type)
        if (!matchesName(nameMatcher(options.typeString), str)) return matchFailure
      }

      if (options?.assignableTo !== undefined) {
        const targetType = isIntrinsicTypeName(options.assignableTo)
          ? yield* project.intrinsicType(options.assignableTo)
          : options.assignableTo
        const assignable = yield* project.isTypeAssignableTo(type, targetType)
        if (!assignable) return matchFailure
      }

      const str = yield* project.typeToString(type)
      return matchSuccess(node, { type: str })
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
  typed,
}
