/** TypeScript semantic and declaration criteria. */
import { Effect, Predicate } from "effect"
import { getJSDocTags, SyntaxKind, type Identifier, type Node } from "typescript/unstable/ast"
import {
  SymbolFlags,
  type Symbol as NativeSymbol,
  type Type as NativeType,
} from "typescript/unstable/async"
import { type NativeCompilerError, nativeRequest } from "../Compiler/Service.ts"
import {
  isProjectFile,
  type ProjectFile,
  type ProjectSnapshot,
  type ProjectSnapshotError,
  type SnapshotExpired,
} from "../Workspace/index.ts"
import type { EvidenceFact } from "../Evidence/Core.ts"
import {
  CriterionBase,
  type Criterion,
  type ProjectScope,
  type Query,
  type QueryContractError,
} from "./Model.ts"
import { identifiers } from "./Sources.ts"
import { where } from "./Operators.ts"

/**
 * Admit nodes that resolve to the given canonical symbol, through import
 * aliases and re-exports. Uses the native checker's batched position lookups.
 */
export const resolvesTo = <A extends Node>(
  symbol: NativeSymbol,
  options?: { readonly location?: (candidate: A) => Node },
): Criterion<A, NativeCompilerError | SnapshotExpired> => ({
  mode: "selection",
  id: "resolves-to-symbol",
  select: (selections) =>
    Effect.gen(function* () {
      const byProjectFile = Map.groupBy(
        selections.map((selection, index) => ({ selection, index })),
        ({ selection }) => `${selection.project.project.id}${selection.fileName}`,
      )
      const facts: Array<Readonly<Record<string, EvidenceFact>> | undefined> = Array.from({
        length: selections.length,
      })
      yield* Effect.all(
        [...byProjectFile.values()].map((group) =>
          Effect.gen(function* () {
            const project = group[0]!.selection.project
            const location = options?.location ?? ((candidate: A): Node => candidate)
            const positions = group.map(({ selection }) => {
              const node = location(selection.value)
              return node.getStart(node.getSourceFile())
            })
            const fileName = project.resolveFileName(group[0]!.selection.fileName)
            const symbols = yield* project.unsafeNative((nativeProject) =>
              nativeRequest("getSymbolsAtPositions", () =>
                nativeProject.checker.getSymbolAtPosition(fileName, positions),
              ),
            )
            yield* Effect.forEach(symbols, (candidate, index) =>
              candidate === undefined
                ? Effect.void
                : Effect.gen(function* () {
                    const canonical = yield* project.unsafeNative((nativeProject) =>
                      (candidate.flags & SymbolFlags.Alias) === 0
                        ? Effect.succeed(candidate)
                        : nativeRequest("getAliasedSymbol", () =>
                            nativeProject.checker.getAliasedSymbol(candidate),
                          ),
                    )
                    if (canonical === symbol) {
                      const declarationFile =
                        symbol.valueDeclaration?.path ?? symbol.declarations[0]?.path
                      facts[group[index]!.index] = {
                        symbol: symbol.name,
                        declarationFile:
                          declarationFile === undefined
                            ? "unknown"
                            : project.relativeFileName(String(declarationFile)),
                      }
                    }
                  }),
            )
          }),
        ),
        { concurrency: 8 },
      )
      return facts
    }),
})

/** Admit nodes that have a specific JSDoc tag (e.g. `@deprecated`, `@internal`). */
export const hasJSDocTag = <A extends Node>(tagName: string): Criterion<A> =>
  CriterionBase.predicate(`jsdoc-tag:${tagName}`, (selection) => {
    const normalizedTag = tagName.replace(/^@/, "")
    const tags = getJSDocTags(selection.value)
    const match = tags.find((t) => t.tagName.text === normalizedTag)
    return match !== undefined ? { tag: normalizedTag } : undefined
  })

interface NodeWithModifiers extends Node {
  readonly modifiers?: ReadonlyArray<{ readonly kind: SyntaxKind }>
}

const hasModifiers = (node: Node): node is NodeWithModifiers => "modifiers" in node

const readModifiers = (node: Node): ReadonlyArray<{ readonly kind: SyntaxKind }> | undefined => {
  if (!hasModifiers(node) || node.modifiers === undefined) return undefined
  return node.modifiers
}

/** Admit nodes that have an export modifier. */
export const isExported = <A extends Node>(): Criterion<A> =>
  CriterionBase.predicate("is-exported", (selection) => {
    const modifiers = readModifiers(selection.value)
    const hasExport =
      modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) ?? false
    return hasExport ? { exported: true } : undefined
  })

/** Find all occurrences across all files in the project that resolve to the given canonical symbol. */
export const referencesTo = (
  target: ProjectScope,
  symbol: NativeSymbol,
): Query<Identifier, ProjectSnapshotError | QueryContractError> =>
  identifiers(target).pipe(where(resolvesTo(symbol)))

/** Inspect the computed TypeScript Type of a node. */
export const typeOf = (
  target: ProjectSnapshot | ProjectFile,
  node: Node,
): Effect.Effect<NativeType | undefined, ProjectSnapshotError> => {
  const project = isProjectFile(target) ? target.project : target
  const sourceFile = node.getSourceFile()
  const fileName = project.relativeFileName(sourceFile.fileName)
  const pos = node.getStart(sourceFile)
  return project.typeAt(fileName, pos)
}

export type IntrinsicTypeName =
  | "string"
  | "number"
  | "boolean"
  | "any"
  | "unknown"
  | "never"
  | "void"

const isIntrinsicTypeName = (value: NativeType | IntrinsicTypeName): value is IntrinsicTypeName =>
  Predicate.isString(value)

/** Admit nodes whose computed type is assignable to `target`. */
export const typeAssignableTo = <A extends Node>(
  target: NativeType | IntrinsicTypeName,
): Criterion<A, NativeCompilerError | SnapshotExpired> => {
  const targetLabel = isIntrinsicTypeName(target) ? target : "custom-type"
  return {
    mode: "selection",
    id: `type-assignable-to:${targetLabel}`,
    select: (selections) =>
      Effect.gen(function* () {
        const facts: Array<Readonly<Record<string, EvidenceFact>> | undefined> = Array.from({
          length: selections.length,
        })
        for (let i = 0; i < selections.length; i++) {
          const selection = selections[i]!
          const node = selection.value
          const sourceFile = node.getSourceFile()
          const pos = node.getStart(sourceFile)
          const nodeType = yield* selection.project.typeAt(selection.fileName, pos)
          if (nodeType === undefined) continue

          const expectedType = isIntrinsicTypeName(target)
            ? yield* selection.project.intrinsicType(target)
            : target

          const assignable = yield* selection.project.isTypeAssignableTo(nodeType, expectedType)
          if (assignable) {
            const typeStr = yield* selection.project.typeToString(nodeType)
            facts[i] = {
              type: typeStr,
              assignableTo: isIntrinsicTypeName(target) ? target : "type",
            }
          }
        }
        return facts
      }),
  }
}

/** Admit nodes whose computed type satisfies a custom predicate. */
export const typeSatisfies = <A extends Node>(
  id: string,
  predicate: (type: NativeType, typeString: string) => boolean,
): Criterion<A, NativeCompilerError | SnapshotExpired> => ({
  mode: "selection",
  id: `type-satisfies:${id}`,
  select: (selections) =>
    Effect.gen(function* () {
      const facts: Array<Readonly<Record<string, EvidenceFact>> | undefined> = Array.from({
        length: selections.length,
      })
      for (let i = 0; i < selections.length; i++) {
        const selection = selections[i]!
        const node = selection.value
        const sourceFile = node.getSourceFile()
        const pos = node.getStart(sourceFile)
        const nodeType = yield* selection.project.typeAt(selection.fileName, pos)
        if (nodeType === undefined) continue

        const typeStr = yield* selection.project.typeToString(nodeType)
        if (predicate(nodeType, typeStr)) {
          facts[i] = { type: typeStr, predicate: id }
        }
      }
      return facts
    }),
})
