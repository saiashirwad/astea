import { Effect, Option } from "effect"
import type { Symbol as NativeSymbol } from "typescript/unstable/async"
import * as Query from "../Query/index.ts"
import type { QueryContractError } from "../Query/index.ts"
import { isProjectFile, type ProjectFile, type ProjectSnapshot, type ProjectSnapshotError } from "../Workspace/index.ts"
import { empty, replaceEach, type Draft } from "./Model.ts"

/** Rename a symbol across all its declarations, imports, and reference occurrences in the project. */
export const renameSymbol = (
  project: ProjectSnapshot,
  symbol: NativeSymbol,
  newName: string,
): Effect.Effect<Draft, ProjectSnapshotError | QueryContractError> =>
  Effect.gen(function*() {
    const references = yield* Query.collect(Query.referencesTo(project, symbol))
    return yield* replaceEach(references, () => newName)
  })

export interface RenameSymbolNamedFn {
  (file: ProjectFile, oldName: string, newName: string): Effect.Effect<Draft, ProjectSnapshotError | QueryContractError>
  (
    project: ProjectSnapshot,
    oldName: string,
    newName: string,
    options: { readonly within: string },
  ): Effect.Effect<Draft, ProjectSnapshotError | QueryContractError>
}

/**
 * Convenience helper to find and rename a symbol by name in a project-relative file or ProjectFile.
 * Returns `Draft.empty` if the symbol is not found (providing natural idempotency).
 */
export const renameSymbolNamed: RenameSymbolNamedFn = (
  projectOrFile: ProjectSnapshot | ProjectFile,
  oldName: string,
  newName: string,
  maybeOptions?: { readonly within: string },
): Effect.Effect<Draft, ProjectSnapshotError | QueryContractError> =>
  Effect.gen(function*() {
    const isFile = isProjectFile(projectOrFile)
    const project = isFile ? projectOrFile.project : projectOrFile
    const within = isFile ? projectOrFile.path : maybeOptions!.within
    const symbolOption = yield* project.findSymbolNamed(oldName, { within })
    if (Option.isNone(symbolOption)) {
      return empty
    }
    return yield* renameSymbol(project, symbolOption.value, newName)
  })
