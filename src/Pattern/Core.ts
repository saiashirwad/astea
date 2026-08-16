/**
 * Pattern domain — declarative AST matching.
 *
 * A Pattern is a declarative, composable matcher over native TypeScript AST nodes.
 * It matches structural syntax and semantic criteria (symbols, types) while extracting
 * strongly typed bindings and producing deterministic query evidence.
 */
import { Effect, Predicate } from "effect"
import {
  type AwaitExpression,
  type CallExpression,
  type ClassDeclaration,
  type DoStatement,
  type ForInStatement,
  type ForOfStatement,
  type ForStatement,
  type FunctionDeclaration,
  type Identifier,
  type IfStatement,
  type Node,
  type NoSubstitutionTemplateLiteral,
  type NumericLiteral,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type ReturnStatement,
  type StringLiteral,
  type TemplateExpression,
  type TryStatement,
  type VariableDeclaration,
  type VariableStatement,
  type WhileStatement,
  SyntaxKind,
} from "typescript/unstable/ast"
import {
  isAwaitExpression,
  isCallExpression,
  isClassDeclaration,
  isDoStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isIdentifier,
  isIfStatement,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isStringLiteral,
  isTemplateExpression,
  isTryStatement,
  isVariableDeclaration,
  isVariableStatement,
  isWhileStatement,
} from "typescript/unstable/ast/is"
import { SymbolFlags, type Symbol as NativeSymbol, type Type as NativeType } from "typescript/unstable/async"
import { nativeRequest } from "../internal/native-compiler.ts"
import { projectRelativePath } from "../internal/project-path.ts"
import type { EvidenceFact } from "../Evidence/Model.ts"
import type { ProjectSnapshot, ProjectSnapshotError } from "../Workspace/index.ts"

export interface PatternMatchResult<Out> {
  readonly matched: true
  readonly value: Out
  readonly facts?: Readonly<Record<string, EvidenceFact>>
}

export interface PatternMismatch {
  readonly matched: false
}

export type PatternResult<Out> = PatternMatchResult<Out> | PatternMismatch

type Binding<K extends string, Out> = { readonly [P in K]: Out }
type TupleMatch<P extends ReadonlyArray<AnyPattern>> = {
  [K in keyof P]: P[K] extends Pattern<Node, infer Out> ? Out : never
}

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
        // SAFETY: predicate authors return true only when `node` is a valid Out.
        const out = node as Out
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
): Pattern<N, Binding<K, Out>> => ({
  kind: `bind(${key})`,
  match: (node, project) =>
    pattern.match(node, project).pipe(
      Effect.map((res) => {
        if (!res.matched) return matchFailure
        // SAFETY: computed key K is preserved by the mapped object construction.
        const bound = { [key]: res.value } as Binding<K, Out> // oxlint-disable-line anti-slop/no-known-value-widening -- The named Binding contract retains K.
        return matchSuccess(bound, res.facts)
      }),
    ),
})

type AnyPattern = Pattern<Node, unknown>

/** Matches an array of patterns against an array of nodes (e.g. call arguments). */
export const tuple = <P extends ReadonlyArray<AnyPattern>>(
  patterns: P,
): Pattern<Node, TupleMatch<P>> => ({
  kind: "tuple",
  match: (node, project) =>
    Effect.gen(function*() {
      const elements: ReadonlyArray<Node> = isCallExpression(node)
        ? node.arguments
        : [node]

      if (elements.length !== patterns.length) return matchFailure

      const values: Array<unknown> = []
      const facts = {} satisfies Record<string, EvidenceFact>

      for (let i = 0; i < patterns.length; i++) {
        const pattern = patterns[i]!
        const elem = elements[i]!
        const result = yield* pattern.match(elem, project)
        if (!result.matched) return matchFailure
        values.push(result.value)
        if (result.facts !== undefined) Object.assign(facts, result.facts)
      }

      // SAFETY: values length and order match the pattern tuple contract.
      const tupleValues = values as TupleMatch<P> // oxlint-disable-line anti-slop/no-known-value-widening -- The named tuple contract is established by the loop.
      return matchSuccess(tupleValues, facts)
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
      const facts = {
        kind: SyntaxKind[node.kind] ?? node.kind,
      } satisfies Record<string, EvidenceFact>

      // SAFETY: without an expression pattern, the caller's default EOut is Node.
      let expressionVal: EOut = node.expression as EOut
      if (options?.expression !== undefined) {
        const expRes = yield* options.expression.match(node.expression, project)
        if (!expRes.matched) return matchFailure
        expressionVal = expRes.value
        if (expRes.facts !== undefined) Object.assign(facts, expRes.facts)
      }

      // SAFETY: without an argument pattern, the caller's default AOut is ReadonlyArray<Node>.
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

export type StringLike = StringLiteral | NoSubstitutionTemplateLiteral | TemplateExpression

/** Check if an AST node is a string literal or template expression. */
export const isStringLike = (node: Node): node is StringLike =>
  isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) || isTemplateExpression(node)

/** Match any string-like node (string literal or template expression). */
export const stringLike = (): Pattern<Node, StringLike> =>
  predicate<Node, StringLike>("string-like", isStringLike)

export interface FunctionDeclarationPatternOptions {
  readonly name?: string | RegExp
  readonly async?: boolean
  readonly exported?: boolean
}

/** Matches a FunctionDeclaration node, optionally filtering by name, async modifier, or export modifier. */
export const functionDeclaration = (
  options?: FunctionDeclarationPatternOptions,
): Pattern<FunctionDeclaration, FunctionDeclaration> => ({
  kind: "functionDeclaration",
  match: (node) =>
    Effect.sync(() => {
      if (!isFunctionDeclaration(node)) return matchFailure
      if (options?.name !== undefined) {
        if (node.name === undefined || !matchesName(nameMatcher(options.name), node.name.text)) {
          return matchFailure
        }
      }
      if (options?.async !== undefined) {
        const isAsync = node.modifiers?.some((m) => m.kind === SyntaxKind.AsyncKeyword) ?? false
        if (isAsync !== options.async) return matchFailure
      }
      if (options?.exported !== undefined) {
        const isExp = node.modifiers?.some((m) => m.kind === SyntaxKind.ExportKeyword) ?? false
        if (isExp !== options.exported) return matchFailure
      }
      if (node.name !== undefined) {
        return matchSuccess(node, {
          kind: SyntaxKind[node.kind] ?? node.kind,
          name: node.name.text,
        })
      }
      return matchSuccess(node, {
        kind: SyntaxKind[node.kind] ?? node.kind,
      })
    }),
})

export interface ClassDeclarationPatternOptions {
  readonly name?: string | RegExp
  readonly exported?: boolean
}

/** Matches a ClassDeclaration node, optionally filtering by name or export modifier. */
export const classDeclaration = (
  options?: ClassDeclarationPatternOptions,
): Pattern<ClassDeclaration, ClassDeclaration> => ({
  kind: "classDeclaration",
  match: (node) =>
    Effect.sync(() => {
      if (!isClassDeclaration(node)) return matchFailure
      if (options?.name !== undefined) {
        if (node.name === undefined || !matchesName(nameMatcher(options.name), node.name.text)) {
          return matchFailure
        }
      }
      if (options?.exported !== undefined) {
        const isExp = node.modifiers?.some((m) => m.kind === SyntaxKind.ExportKeyword) ?? false
        if (isExp !== options.exported) return matchFailure
      }
      if (node.name !== undefined) {
        return matchSuccess(node, {
          kind: SyntaxKind[node.kind] ?? node.kind,
          name: node.name.text,
        })
      }
      return matchSuccess(node, {
        kind: SyntaxKind[node.kind] ?? node.kind,
      })
    }),
})

export interface TryStatementPatternOptions {
  readonly hasCatch?: boolean
  readonly hasFinally?: boolean
}

/** Matches a TryStatement node, optionally checking for catch and finally clauses. */
export const tryStatement = (
  options?: TryStatementPatternOptions,
): Pattern<TryStatement, TryStatement> => ({
  kind: "tryStatement",
  match: (node) =>
    Effect.sync(() => {
      if (!isTryStatement(node)) return matchFailure
      if (options?.hasCatch !== undefined) {
        const hasCatch = node.catchClause !== undefined
        if (hasCatch !== options.hasCatch) return matchFailure
      }
      if (options?.hasFinally !== undefined) {
        const hasFinally = node.finallyBlock !== undefined
        if (hasFinally !== options.hasFinally) return matchFailure
      }
      return matchSuccess(node, {
        kind: SyntaxKind[node.kind] ?? node.kind,
        hasCatch: node.catchClause !== undefined,
        hasFinally: node.finallyBlock !== undefined,
      })
    }),
})

export type LoopStatement = ForStatement | ForOfStatement | ForInStatement | WhileStatement | DoStatement

export interface LoopPatternOptions {
  readonly kind?: "for" | "for-of" | "for-in" | "while" | "do-while"
}

/** Matches any loop statement (`for`, `for-of`, `for-in`, `while`, `do-while`). */
export const loop = (
  options?: LoopPatternOptions,
): Pattern<LoopStatement, LoopStatement> => ({
  kind: "loop",
  match: (node) =>
    Effect.sync(() => {
      if (options?.kind === "for") {
        if (!isForStatement(node)) return matchFailure
        return matchSuccess(node, { loopKind: "ForStatement" })
      }
      if (options?.kind === "for-of") {
        if (!isForOfStatement(node)) return matchFailure
        return matchSuccess(node, { loopKind: "ForOfStatement" })
      }
      if (options?.kind === "for-in") {
        if (!isForInStatement(node)) return matchFailure
        return matchSuccess(node, { loopKind: "ForInStatement" })
      }
      if (options?.kind === "while") {
        if (!isWhileStatement(node)) return matchFailure
        return matchSuccess(node, { loopKind: "WhileStatement" })
      }
      if (options?.kind === "do-while") {
        if (!isDoStatement(node)) return matchFailure
        return matchSuccess(node, { loopKind: "DoStatement" })
      }
      if (
        !isForStatement(node) &&
        !isForOfStatement(node) &&
        !isForInStatement(node) &&
        !isWhileStatement(node) &&
        !isDoStatement(node)
      ) {
        return matchFailure
      }
      // SAFETY: node is verified to be one of the LoopStatement subtypes by the if-guard above.
      const loopNode = node as LoopStatement
      return matchSuccess(loopNode, { loopKind: SyntaxKind[node.kind] ?? node.kind })
    }),
})

/** Matches a `for (...)` statement. */
export const forStatement = (): Pattern<ForStatement, ForStatement> =>
  predicate<ForStatement, ForStatement>("forStatement", isForStatement)

/** Matches a `for (... of ...)` statement. */
export const forOfStatement = (): Pattern<ForOfStatement, ForOfStatement> =>
  predicate<ForOfStatement, ForOfStatement>("forOfStatement", isForOfStatement)

/** Matches a `for (... in ...)` statement. */
export const forInStatement = (): Pattern<ForInStatement, ForInStatement> =>
  predicate<ForInStatement, ForInStatement>("forInStatement", isForInStatement)

/** Matches a `while (...)` statement. */
export const whileStatement = (): Pattern<WhileStatement, WhileStatement> =>
  predicate<WhileStatement, WhileStatement>("whileStatement", isWhileStatement)

/** Matches a `do ... while (...)` statement. */
export const doStatement = (): Pattern<DoStatement, DoStatement> =>
  predicate<DoStatement, DoStatement>("doStatement", isDoStatement)

export interface AwaitExpressionPatternOptions<EOut = Node> {
  readonly expression?: Pattern<Node, EOut>
}

/** Matches an AwaitExpression node, optionally verifying its inner expression pattern. */
export const awaitExpression = <EOut = Node>(
  options?: AwaitExpressionPatternOptions<EOut>,
): Pattern<AwaitExpression, AwaitExpression> => ({
  kind: "awaitExpression",
  match: (node, project) =>
    Effect.gen(function*() {
      if (!isAwaitExpression(node)) return matchFailure
      if (options?.expression !== undefined) {
        const expRes = yield* options.expression.match(node.expression, project)
        if (!expRes.matched) return matchFailure
      }
      return matchSuccess(node, { kind: SyntaxKind[node.kind] ?? node.kind })
    }),
})

export interface VariableStatementPatternOptions {
  readonly name?: string | RegExp
  readonly exported?: boolean
}

/** Matches a VariableStatement node, optionally filtering by variable name or export modifier. */
export const variableStatement = (
  options?: VariableStatementPatternOptions,
): Pattern<VariableStatement, VariableStatement> => ({
  kind: "variableStatement",
  match: (node) =>
    Effect.sync(() => {
      if (!isVariableStatement(node)) return matchFailure
      if (options?.exported !== undefined) {
        const isExp = node.modifiers?.some((m) => m.kind === SyntaxKind.ExportKeyword) ?? false
        if (isExp !== options.exported) return matchFailure
      }
      if (options?.name !== undefined) {
        const matcher = nameMatcher(options.name)
        const hasMatchingName = node.declarationList.declarations.some(
          (decl) => isIdentifier(decl.name) && matchesName(matcher, decl.name.text),
        )
        if (!hasMatchingName) return matchFailure
      }
      return matchSuccess(node, { kind: SyntaxKind[node.kind] ?? node.kind })
    }),
})

export interface VariableDeclarationPatternOptions {
  readonly name?: string | RegExp
}

/** Matches a VariableDeclaration node, optionally filtering by variable name. */
export const variableDeclaration = (
  options?: VariableDeclarationPatternOptions,
): Pattern<VariableDeclaration, VariableDeclaration> => ({
  kind: "variableDeclaration",
  match: (node) =>
    Effect.sync(() => {
      if (!isVariableDeclaration(node)) return matchFailure
      if (options?.name !== undefined) {
        if (!isIdentifier(node.name) || !matchesName(nameMatcher(options.name), node.name.text)) {
          return matchFailure
        }
      }
      if (isIdentifier(node.name)) {
        return matchSuccess(node, {
          kind: SyntaxKind[node.kind] ?? node.kind,
          name: node.name.text,
        })
      }
      return matchSuccess(node, {
        kind: SyntaxKind[node.kind] ?? node.kind,
      })
    }),
})

export interface IfStatementPatternOptions {
  readonly hasElse?: boolean
}

/** Matches an IfStatement node, optionally checking for presence of an else branch. */
export const ifStatement = (
  options?: IfStatementPatternOptions,
): Pattern<IfStatement, IfStatement> => ({
  kind: "ifStatement",
  match: (node) =>
    Effect.sync(() => {
      if (!isIfStatement(node)) return matchFailure
      if (options?.hasElse !== undefined) {
        const hasElse = node.elseStatement !== undefined
        if (hasElse !== options.hasElse) return matchFailure
      }
      return matchSuccess(node, {
        kind: SyntaxKind[node.kind] ?? node.kind,
        hasElse: node.elseStatement !== undefined,
      })
    }),
})

export interface ReturnStatementPatternOptions<EOut = Node> {
  readonly expression?: Pattern<Node, EOut>
}

/** Matches a ReturnStatement node, optionally verifying its returned expression pattern. */
export const returnStatement = <EOut = Node>(
  options?: ReturnStatementPatternOptions<EOut>,
): Pattern<ReturnStatement, ReturnStatement> => ({
  kind: "returnStatement",
  match: (node, project) =>
    Effect.gen(function*() {
      if (!isReturnStatement(node)) return matchFailure
      if (options?.expression !== undefined) {
        if (node.expression === undefined) return matchFailure
        const expRes = yield* options.expression.match(node.expression, project)
        if (!expRes.matched) return matchFailure
      }
      return matchSuccess(node, { kind: SyntaxKind[node.kind] ?? node.kind })
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
  stringLike,
  isStringLike,
  numericLiteral,
  objectLiteral,
  typed,
  functionDeclaration,
  classDeclaration,
  tryStatement,
  loop,
  forStatement,
  forOfStatement,
  forInStatement,
  whileStatement,
  doStatement,
  awaitExpression,
  variableStatement,
  variableDeclaration,
  ifStatement,
  returnStatement,
}
