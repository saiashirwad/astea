/**
 * Candidate public API — semantic queries.
 *
 * A Query is an Effect Stream of evidence-bearing Selections over native
 * TypeScript values. Selections carry the Project Snapshot they came from, so
 * semantic criteria (`Query.resolvesTo`, custom `Criterion`s) need no project
 * argument and compose across a multi-project workspace. Native node types
 * flow through with exact inference — there is no wrapper hierarchy.
 */
import * as Path from "node:path"
import { Data, Effect, Stream } from "effect"
import {
  SyntaxKind,
  type CallExpression,
  type ImportDeclaration,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast"
import { isCallExpression, isImportDeclaration } from "typescript/unstable/ast/is"
import { SymbolFlags, type Symbol as NativeSymbol } from "typescript/unstable/async"
import { type NativeCompilerError, nativeRequest } from "../prototype/native-compiler.ts"
import { isWithinProject, projectRelativePath } from "../prototype/project-path.ts"
import type { ProjectSnapshot, ProjectSnapshotError, SnapshotExpired } from "./workspace.ts"

export type EvidenceFact = string | number | boolean | null

/** Deterministic facts explaining why a Selection qualified. */
export interface QueryEvidence {
  readonly criterion: string
  readonly facts: Readonly<Record<string, EvidenceFact>>
}

/**
 * An occurrence admitted by a query: the snapshot-scoped native value, its
 * durable project-relative location, the Project Snapshot it belongs to, and
 * the evidence explaining why it qualified.
 */
export interface Selection<A> {
  readonly value: A
  readonly project: ProjectSnapshot
  /** Project-relative, case-preserving path. Safe for durable evidence. */
  readonly fileName: string
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

/**
 * A batched semantic criterion. `select` receives a batch of Selections and
 * returns aligned optional evidence facts: `undefined` rejects the candidate,
 * facts admit it and are recorded as Query Evidence. A length mismatch is a
 * QueryContractError.
 */
export interface Criterion<A, E = never, R = never> {
  readonly id: string
  readonly batchSize?: number
  readonly select: (
    selections: ReadonlyArray<Selection<A>>,
  ) => Effect.Effect<ReadonlyArray<Readonly<Record<string, EvidenceFact>> | undefined>, E, R>
}

const collectNodes = <A extends Node>(
  project: ProjectSnapshot,
  sourceFile: SourceFile,
  guard: (node: Node) => node is A,
): Array<Selection<A>> => {
  const selections: Array<Selection<A>> = []
  const fileName = isWithinProject(project.root, sourceFile.fileName)
    ? projectRelativePath(project.root, sourceFile.fileName)
    : sourceFile.fileName

  const visit = (node: Node): void => {
    if (guard(node)) {
      selections.push({
        value: node,
        project,
        fileName,
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

/** All descendant nodes of the given kind, in every file the project checks. */
export const nodes = <A extends Node>(
  project: ProjectSnapshot,
  guard: (node: Node) => node is A,
): Query<A, ProjectSnapshotError> =>
  Stream.fromIterableEffect(project.sourceFileNames()).pipe(
    Stream.flatMap((fileName) =>
      Stream.fromEffect(project.unsafeNative((nativeProject) =>
        nativeRequest("getSourceFile", () => nativeProject.program.getSourceFile(fileName))
      ))
    ),
    Stream.flatMap((sourceFile) =>
      sourceFile === undefined ? Stream.empty : Stream.fromIterable(collectNodes(project, sourceFile, guard))
    ),
  )

export const calls = (project: ProjectSnapshot): Query<CallExpression, ProjectSnapshotError> =>
  nodes(project, isCallExpression)

export const imports = (project: ProjectSnapshot): Query<ImportDeclaration, ProjectSnapshotError> =>
  nodes(project, isImportDeclaration)

/** Admit only selections the criterion produces evidence for. */
export const where = <A, E2, R2>(
  criterion: Criterion<A, E2, R2>,
) =>
<E, R>(self: Query<A, E, R>): Query<A, E | E2 | QueryContractError, R | R2> =>
  self.pipe(
    Stream.grouped(criterion.batchSize ?? 128),
    Stream.mapEffect((batch) =>
      Effect.gen(function*() {
        const facts = yield* criterion.select(batch)
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
              evidence: [...selection.evidence, { criterion: criterion.id, facts: selectedFacts }],
            }]
        })
      })
    ),
    Stream.flatMap((batch) => Stream.fromIterable(batch)),
  )

/**
 * Admit nodes that resolve to the given canonical symbol, through import
 * aliases and re-exports. Uses the native checker's batched position lookups;
 * each selection's own Project Snapshot answers for it, so a stream may mix
 * selections from several Configured Projects.
 */
export const resolvesTo = <A extends Node>(
  symbol: NativeSymbol,
  options?: { readonly location?: (candidate: A) => Node },
): Criterion<A, NativeCompilerError | SnapshotExpired> => ({
  id: "resolves-to-symbol",
  select: (selections) =>
    Effect.gen(function*() {
      // Position requests are intentional. TypeScript 7 may retain decoded
      // nodes for unchanged files across snapshots while checker handles
      // remain generation-local; sending retained nodes to a newer checker
      // can produce stale handles. Stable file/position inputs are equivalent.
      const byProjectFile = Map.groupBy(
        selections.map((selection, index) => ({ selection, index })),
        ({ selection }) => `${selection.project.project.id}${selection.fileName}`,
      )
      const facts = new Array<Readonly<Record<string, EvidenceFact>> | undefined>(selections.length)
      yield* Effect.all([...byProjectFile.values()].map((group) =>
        Effect.gen(function*() {
          const project = group[0]!.selection.project
          const location = options?.location ?? ((candidate: A): Node => candidate)
          const positions = group.map(({ selection }) => {
            const node = location(selection.value)
            return node.getStart(node.getSourceFile())
          })
          const fileName = Path.resolve(project.root, group[0]!.selection.fileName)
          const symbols = yield* project.unsafeNative((nativeProject) =>
            nativeRequest(
              "getSymbolsAtPositions",
              () => nativeProject.checker.getSymbolAtPosition(fileName, positions),
            ))
          yield* Effect.forEach(symbols, (candidate, index) =>
            candidate === undefined ? Effect.void : Effect.gen(function*() {
              const canonical = yield* project.unsafeNative((nativeProject) =>
                (candidate.flags & SymbolFlags.Alias) === 0
                  ? Effect.succeed(candidate)
                  : nativeRequest(
                    "getAliasedSymbol",
                    () => nativeProject.checker.getAliasedSymbol(candidate),
                  ))
              if (canonical === symbol) {
                const declarationFile = symbol.valueDeclaration?.path ?? symbol.declarations[0]?.path
                facts[group[index]!.index] = {
                  symbol: symbol.name,
                  declarationFile: declarationFile === undefined
                    ? "unknown"
                    : projectRelativePath(project.root, String(declarationFile)),
                }
              }
            }))
        })
      ), { concurrency: 8 })
      return facts
    }),
})

/** Selection-level predicate filter; evidence of surviving selections is preserved. */
export const filter = <A, E, R>(
  predicate: (selection: Selection<A>) => boolean,
) =>
(self: Query<A, E, R>): Query<A, E, R> => Stream.filter(self, predicate)

/**
 * Run a query to completion in canonical plan order: project ID,
 * project-relative file, start, end. Discovery timing never controls order.
 */
export const collect = <A, E, R>(
  self: Query<A, E, R>,
): Effect.Effect<ReadonlyArray<Selection<A>>, E, R> =>
  Stream.runCollect(self).pipe(
    Effect.map((selections) =>
      [...selections].sort((left, right) =>
        left.project.project.id.localeCompare(right.project.project.id) ||
        left.fileName.localeCompare(right.fileName) ||
        left.start - right.start ||
        left.end - right.end
      )
    ),
  )

export const Query = {
  nodes,
  calls,
  imports,
  where,
  resolvesTo,
  filter,
  collect,
}
