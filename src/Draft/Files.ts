import { path as Path } from "../platform/node.ts"
import { Effect } from "effect"
import { isImportDeclaration, isStringLiteral } from "typescript/unstable/ast/is"
import { textHash } from "../Edit/Hash.ts"
import type { QueryContractError } from "../Query/index.ts"
import {
  InvalidProjectRelativePath,
  parseProjectRelativePath,
  projectRelativePath,
  type ProjectRelativePath,
} from "../Workspace/ProjectPath.ts"
import type {
  FileNotFound,
  ProjectSnapshot,
  ProjectSnapshotError,
  SnapshotExpired,
} from "../Workspace/index.ts"
import { concat, type Draft, type ProposedEdit } from "./Model.ts"

// // =============================================================================

export const files = {
  /** Propose creating a new source file in the project with initial content. */
  create: (
    project: ProjectSnapshot,
    relativePath: string,
    content: string,
  ): Effect.Effect<Draft, SnapshotExpired | InvalidProjectRelativePath> =>
    Effect.gen(function* () {
      const path = yield* checkedPath(relativePath)
      return yield* project.unsafeNative(() =>
        Effect.sync((): Draft => ({
          edits: [],
          fileOperations: [
            {
              kind: "create",
              projectId: project.project.id,
              path,
              content,
              evidenceIds: [`file:create:${path}`],
            },
          ],
          evidence: [
            { id: `file:create:${path}`, kind: "file-operation", facts: { kind: "create", path } },
          ],
          matches: 1,
        })),
      )
    }),

  /** Propose deleting an existing source file from the project. */
  delete: (
    project: ProjectSnapshot,
    relativePath: string,
  ): Effect.Effect<Draft, ProjectSnapshotError | FileNotFound | InvalidProjectRelativePath> =>
    Effect.gen(function* () {
      const path = yield* checkedPath(relativePath)
      const source = yield* project.sourceText(path)
      return yield* project.unsafeNative(() =>
        Effect.sync((): Draft => ({
          edits: [],
          fileOperations: [
            {
              kind: "delete",
              projectId: project.project.id,
              path,
              initialHash: textHash(source),
              evidenceIds: [`file:delete:${path}`],
            },
          ],
          evidence: [
            { id: `file:delete:${path}`, kind: "file-operation", facts: { kind: "delete", path } },
          ],
          matches: 1,
        })),
      )
    }),

  /** Propose moving/renaming a source file and automatically rewrites relative import references across the project. */
  move: (
    project: ProjectSnapshot,
    fromPath: string,
    toPath: string,
  ): Effect.Effect<
    Draft,
    ProjectSnapshotError | FileNotFound | QueryContractError | InvalidProjectRelativePath
  > =>
    Effect.gen(function* () {
      const sourcePath = yield* checkedPath(fromPath)
      const targetPath = yield* checkedPath(toPath)
      const source = yield* project.sourceText(sourcePath)
      const moveEvidence = `file:move:${sourcePath}->${targetPath}`
      const fileOpDraft: Draft = {
        edits: [],
        fileOperations: [
          {
            kind: "move",
            projectId: project.project.id,
            path: sourcePath,
            toPath: targetPath,
            content: source,
            initialHash: textHash(source),
            evidenceIds: [moveEvidence],
          },
        ],
        evidence: [
          {
            id: moveEvidence,
            kind: "file-operation",
            facts: { kind: "move", path: sourcePath, toPath: targetPath },
          },
        ],
        matches: 1,
      }

      // Compute relative module specifier adjustments across all files in the project
      const fromBase = sourcePath.replace(/\.(ts|tsx|js|jsx)$/, "")
      const toBase = targetPath.replace(/\.(ts|tsx|js|jsx)$/, "")

      const importEdits: Array<ProposedEdit> = []
      const sourceNames = yield* project.sourceFileNames

      for (const absFile of sourceNames) {
        const file = yield* project.sourceFile(absFile)
        if (file === undefined) continue
        const relFile = projectRelativePath(project.root, file.fileName)
        if (relFile === sourcePath) continue

        for (const statement of file.statements) {
          if (isImportDeclaration(statement)) {
            const specifier = statement.moduleSpecifier
            if (isStringLiteral(specifier)) {
              const specText = specifier.text
              const fileDir = Path.dirname(relFile)
              const resolvedImport = Path.normalize(Path.join(fileDir, specText)).replace(
                /\.(ts|tsx|js|jsx)$/,
                "",
              )
              if (
                resolvedImport === fromBase ||
                resolvedImport === `./${fromBase}` ||
                resolvedImport === sourcePath
              ) {
                let newRel = Path.relative(fileDir, toBase)
                if (!newRel.startsWith(".")) newRel = `./${newRel}`
                const ext = specText.endsWith(".js") ? ".js" : specText.endsWith(".ts") ? ".ts" : ""
                const newSpecText = `${newRel}${ext}`
                const start = specifier.getStart(file)
                const end = specifier.getEnd()
                const quote = file.text[start] === "'" ? "'" : '"'
                const importEvidenceId = `import:move-target:${relFile}:${start}-${end}`
                importEdits.push({
                  projectId: project.project.id,
                  fileName: relFile,
                  start,
                  end,
                  expectedTextHash: textHash(file.text.slice(start, end)),
                  newText: `${quote}${newSpecText}${quote}`,
                  evidenceIds: [importEvidenceId],
                })
              }
            }
          }
        }
      }

      const importDraft: Draft = {
        edits: importEdits,
        evidence: importEdits.flatMap((edit) =>
          edit.evidenceIds.map((id) => ({
            id,
            kind: "file-import-rewrite",
            facts: { fileName: edit.fileName, target: targetPath },
          })),
        ),
        matches: importEdits.length,
      }
      return concat(fileOpDraft, importDraft)
    }),
}

const checkedPath = (
  value: string,
): Effect.Effect<ProjectRelativePath, InvalidProjectRelativePath> => {
  const path = parseProjectRelativePath(value)
  return path === undefined
    ? Effect.fail(new InvalidProjectRelativePath({ path: value }))
    : Effect.succeed(path)
}

// =============================================================================
