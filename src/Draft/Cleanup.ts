import { Effect } from "effect"
import { isImportDeclaration, isNamedImports } from "typescript/unstable/ast/is"
import * as Query from "../Query/index.ts"
import type { QueryContractError } from "../Query/index.ts"
import type { ProjectSnapshot, ProjectSnapshotError } from "../Workspace/index.ts"
import { imports } from "./Imports.ts"
import { concat, empty, type Draft } from "./Model.ts"

/** Clean up unused imports and unused declarations identified by TypeScript compiler diagnostics. */
export const cleanUnused = (
  project: ProjectSnapshot,
): Effect.Effect<Draft, ProjectSnapshotError | QueryContractError> =>
  Effect.gen(function* () {
    let accumulated = empty
    const sourceNames = yield* project.sourceFileNames

    for (const absPath of sourceNames) {
      const file = yield* project.sourceFile(absPath)
      if (file === undefined) continue

      for (const statement of file.statements) {
        if (
          isImportDeclaration(statement) &&
          statement.importClause?.namedBindings &&
          isNamedImports(statement.importClause.namedBindings)
        ) {
          const named = statement.importClause.namedBindings
          for (const element of named.elements) {
            const sym = yield* project.symbolAt(file.fileName, element.name.getStart(file))
            if (sym !== undefined) {
              const refs = yield* Query.collect(Query.referencesTo(project, sym))
              // If only reference is the import itself
              if (refs.length <= 1) {
                const draft = yield* imports.removeNamed(project, statement, element.name.text)
                const conflicts = draft.edits.some((candidate) =>
                  accumulated.edits.some(
                    (existing) =>
                      candidate.projectId === existing.projectId &&
                      candidate.fileName === existing.fileName &&
                      candidate.start < existing.end &&
                      existing.start < candidate.end,
                  ),
                )
                if (!conflicts) accumulated = concat(accumulated, draft)
              }
            }
          }
        }
      }
    }

    return accumulated
  })
