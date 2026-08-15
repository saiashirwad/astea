/**
 * PROTOTYPE — a semantic query is an Effect Stream of evidence-bearing selections.
 */
import * as Path from "node:path"
import { Data, Effect, Stream } from "effect"
import {
  SyntaxKind,
  type CallExpression,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast"
import { isCallExpression } from "typescript/unstable/ast/is"
import {
  SymbolFlags,
  type NodeHandle,
  type Symbol as NativeSymbol,
} from "typescript/unstable/async"
import { nativeRequest, type NativeCompilerError } from "./native-compiler.ts"
import {
  type ProjectSnapshot,
  type ProjectSnapshotError,
  SnapshotExpired,
} from "./workspace-snapshot.ts"

export type EvidenceFact = string | number | boolean | null

export interface QueryEvidence {
  readonly criterion: string
  readonly facts: Readonly<Record<string, EvidenceFact>>
}

export interface Selection<A> {
  readonly value: A
  readonly fileName: string
  readonly canonicalFileName: string
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

export interface BatchedCriterion<A, E = never, R = never> {
  readonly id: string
  readonly batchSize?: number
  readonly evaluate: (
    candidates: ReadonlyArray<A>,
  ) => Effect.Effect<ReadonlyArray<Readonly<Record<string, EvidenceFact>> | undefined>, E, R>
}

const collectNodes = <A extends Node>(
  sourceFile: SourceFile,
  guard: (node: Node) => node is A,
): Array<Selection<A>> => {
  const selections: Array<Selection<A>> = []

  const visit = (node: Node): void => {
    if (guard(node)) {
      selections.push({
        value: node,
        fileName: sourceFile.fileName,
        canonicalFileName: String(sourceFile.path),
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

export const nodes = <A extends Node>(
  project: ProjectSnapshot,
  guard: (node: Node) => node is A,
): Query<A, ProjectSnapshotError> => Stream.fromIterableEffect(project.sourceFileNames()).pipe(
  Stream.flatMap((fileName) => Stream.fromEffect(project.unsafeNative((nativeProject) =>
    nativeRequest("getSourceFile", () => nativeProject.program.getSourceFile(fileName))))),
  Stream.flatMap((sourceFile) => sourceFile === undefined
    ? Stream.empty
    : Stream.fromIterable(collectNodes(sourceFile, guard))),
)

export const calls = (
  project: ProjectSnapshot,
): Query<CallExpression, ProjectSnapshotError> => nodes(project, isCallExpression)

export const whereBatched = <A, E2, R2>(
  criterion: BatchedCriterion<A, E2, R2>,
) => <E, R>(
  self: Query<A, E, R>,
): Query<A, E | E2 | QueryContractError, R | R2> => self.pipe(
  Stream.grouped(criterion.batchSize ?? 128),
  Stream.mapEffect((batch) => Effect.gen(function*() {
    const facts = yield* criterion.evaluate(batch.map((selection) => selection.value))
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
          evidence: [...selection.evidence, {
            criterion: criterion.id,
            facts: selectedFacts,
          }],
        }]
    })
  })),
  Stream.flatMap((batch) => Stream.fromIterable(batch)),
)

export const collect = <A, E, R>(
  self: Query<A, E, R>,
): Effect.Effect<ReadonlyArray<Selection<A>>, E, R> => Stream.runCollect(self).pipe(
  Effect.map((selections) => [...selections].sort((left, right) =>
    left.canonicalFileName.localeCompare(right.canonicalFileName) ||
    left.start - right.start ||
    left.end - right.end)),
)

const canonicalSymbol = (
  project: ProjectSnapshot,
  symbol: NativeSymbol,
): Effect.Effect<NativeSymbol, NativeCompilerError | SnapshotExpired> =>
  (symbol.flags & SymbolFlags.Alias) === 0
    ? Effect.succeed(symbol)
    : project.unsafeNative((nativeProject) =>
      nativeRequest("getAliasedSymbol", () => nativeProject.checker.getAliasedSymbol(symbol)))

export const symbolAtPosition = (
  project: ProjectSnapshot,
  fileName: string,
  position: number,
): Effect.Effect<NativeSymbol | undefined, ProjectSnapshotError> => project.unsafeNative((nativeProject) =>
  nativeRequest("getSymbolAtPosition", () => nativeProject.checker.getSymbolAtPosition(fileName, position)))

export const resolvesNodeToSymbol = <A extends Node>(
  project: ProjectSnapshot,
  target: NativeSymbol,
  location: (candidate: A) => Node = (candidate) => candidate,
): BatchedCriterion<A, NativeCompilerError | SnapshotExpired> => ({
  id: "resolves-to-symbol",
  evaluate: (candidates) => project.unsafeNative((nativeProject) => Effect.gen(function*() {
    // Position requests are intentional. TypeScript 7 may retain decoded nodes for
    // unchanged files across snapshots while checker handles remain generation-local.
    // Sending those retained nodes back to a newer checker can produce stale handles.
    const byFile = Map.groupBy(candidates.map((candidate, index) => ({
      candidate,
      index,
      location: location(candidate),
    })), ({ location }) => location.getSourceFile().fileName)
    const symbols = new Array<NativeSymbol | undefined>(candidates.length)
    yield* Effect.all([...byFile].map(([fileName, entries]) => nativeRequest(
      "getSymbolsAtPositions",
      async () => {
        const resolved = await nativeProject.checker.getSymbolAtPosition(
          fileName,
          entries.map((entry) => entry.location.getStart(entry.location.getSourceFile())),
        )
        for (let index = 0; index < entries.length; index++) {
          symbols[entries[index]!.index] = resolved[index]
        }
      },
    )), { concurrency: 8 })
    const canonical = yield* Effect.all(symbols.map((symbol) =>
      symbol === undefined ? Effect.succeed(undefined) : canonicalSymbol(project, symbol)))
    const declarationFile = target.valueDeclaration?.path ?? target.declarations[0]?.path
    const canonicalProjectRoot = Path.dirname(String(nativeProject.id))

    return canonical.map((symbol) => symbol === target
      ? {
        symbol: target.name,
        declarationFile: declarationFile === undefined
          ? "unknown"
          : Path.relative(canonicalProjectRoot, String(declarationFile)),
      }
      : undefined)
  })),
})

export const resolvesToSymbol = (
  project: ProjectSnapshot,
  target: NativeSymbol,
): BatchedCriterion<CallExpression, NativeCompilerError | SnapshotExpired> =>
  resolvesNodeToSymbol(project, target, (candidate) => candidate.expression)

export const referencesInProject = (
  project: ProjectSnapshot,
  symbol: NativeSymbol,
): Effect.Effect<ReadonlyArray<NodeHandle>, ProjectSnapshotError> => Effect.gen(function*() {
  const fileNames = yield* project.sourceFileNames()
  const references = yield* project.unsafeNative((nativeProject) => Effect.all(
    fileNames.map((fileName) => nativeRequest(
      "getReferencesToSymbolInFile",
      () => nativeProject.checker.getReferencesToSymbolInFile(fileName, symbol),
    )),
    { concurrency: 8 },
  ))
  return references.flat().sort((left, right) =>
    String(left.path).localeCompare(String(right.path)) || left.index - right.index)
})
