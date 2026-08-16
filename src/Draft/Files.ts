import { path as Path } from "../platform/node.ts"
import { Effect } from "effect"
import { isImportDeclaration, isStringLiteral } from "typescript/unstable/ast/is"
import { textHash } from "../Edit/Hash.ts"
import type { QueryContractError } from "../Query/index.ts"
import { projectRelativePath } from "../Workspace/ProjectPath.ts"
import type { FileNotFound, ProjectSnapshot, ProjectSnapshotError, SnapshotExpired } from "../Workspace/index.ts"
import { concat, type Draft, type ProposedEdit } from "./Model.ts"

// // =============================================================================

export const files = {
  /** Propose creating a new source file in the project with initial content. */
  create: (
    project: ProjectSnapshot,
    relativePath: string,
    content: string,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => ({
        edits: [],
        fileOperations: [{
          kind: "create",
          projectId: project.project.id,
          path: relativePath,
          content,
          evidenceIds: [`file:create:${relativePath}`],
        }],
        evidence: [],
        matches: 1,
      }))
    ),

  /** Propose deleting an existing source file from the project. */
  delete: (
    project: ProjectSnapshot,
    relativePath: string,
  ): Effect.Effect<Draft, ProjectSnapshotError | FileNotFound> =>
    Effect.gen(function*() {
      const source = yield* project.sourceText(relativePath)
      return yield* project.unsafeNative(() =>
        Effect.sync((): Draft => ({
          edits: [],
          fileOperations: [{
            kind: "delete",
            projectId: project.project.id,
            path: relativePath,
            initialHash: textHash(source),
            evidenceIds: [`file:delete:${relativePath}`],
          }],
          evidence: [],
          matches: 1,
        }))
      )
    }),

  /** Propose moving/renaming a source file and automatically rewrites relative import references across the project. */
  move: (
    project: ProjectSnapshot,
    fromPath: string,
    toPath: string,
  ): Effect.Effect<Draft, ProjectSnapshotError | FileNotFound | QueryContractError> =>
    Effect.gen(function*() {
      const source = yield* project.sourceText(fromPath)
      const fileOpDraft: Draft = {
        edits: [],
        fileOperations: [{
          kind: "move",
          projectId: project.project.id,
          path: fromPath,
          toPath,
          content: source,
          initialHash: textHash(source),
          evidenceIds: [`file:move:${fromPath}->${toPath}`],
        }],
        evidence: [],
        matches: 1,
      }

      // Compute relative module specifier adjustments across all files in the project
      const fromBase = fromPath.replace(/\.(ts|tsx|js|jsx)$/, "")
      const toBase = toPath.replace(/\.(ts|tsx|js|jsx)$/, "")

      const importEdits: Array<ProposedEdit> = []
      const sourceNames = yield* project.sourceFileNames

      for (const absFile of sourceNames) {
        const file = yield* project.sourceFile(absFile)
        if (file === undefined) continue
        const relFile = projectRelativePath(project.root, file.fileName)
        if (relFile === fromPath) continue

        for (const statement of file.statements) {
          if (isImportDeclaration(statement)) {
            const specifier = statement.moduleSpecifier
            if (isStringLiteral(specifier)) {
              const specText = specifier.text
              const fileDir = Path.dirname(relFile)
              const resolvedImport = Path.normalize(Path.join(fileDir, specText)).replace(/\.(ts|tsx|js|jsx)$/, "")
              if (resolvedImport === fromBase || resolvedImport === `./${fromBase}` || resolvedImport === fromPath) {
                let newRel = Path.relative(fileDir, toBase)
                if (!newRel.startsWith(".")) newRel = `./${newRel}`
                const ext = specText.endsWith(".js") ? ".js" : specText.endsWith(".ts") ? ".ts" : ""
                const newSpecText = `${newRel}${ext}`
                const start = specifier.getStart(file)
                const end = specifier.getEnd()
                const quote = file.text[start] === "'" ? "'" : '"'
                importEdits.push({
                  projectId: project.project.id,
                  fileName: relFile,
                  start,
                  end,
                  expectedTextHash: textHash(file.text.slice(start, end)),
                  newText: `${quote}${newSpecText}${quote}`,
                  evidenceIds: [`import:move-target:${relFile}`],
                })
              }
            }
          }
        }
      }

      const importDraft: Draft = { edits: importEdits, evidence: [], matches: importEdits.length }
      return concat(fileOpDraft, importDraft)
    }),
}

// =============================================================================
