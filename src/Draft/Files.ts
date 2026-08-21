import { Effect } from "effect"
import type { QueryContractError } from "../Query/index.ts"
import {
  InvalidProjectRelativePath,
  parseProjectRelativePath,
  type ProjectRelativePath,
} from "../ProjectPath/index.ts"
import type {
  FileNotFound,
  ProjectSnapshot,
  ProjectSnapshotError,
  SnapshotExpired,
} from "../Workspace/index.ts"
import { textHash } from "../Edit/Hash.ts"
import {
  applySpecifierReplacements,
  specifierReplacements,
  stripModuleExtension,
} from "./internal/ModuleSpecifiers.ts"
import { concat, type Draft, type ProposedEdit } from "./Draft.ts"

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
              evidenceIds: [`file:create:${project.project.id}:${path}`],
            },
          ],
          evidence: [
            {
              id: `file:create:${project.project.id}:${path}`,
              kind: "file-operation",
              facts: { kind: "create", projectId: project.project.id, path },
            },
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
              evidenceIds: [`file:delete:${project.project.id}:${path}`],
            },
          ],
          evidence: [
            {
              id: `file:delete:${project.project.id}:${path}`,
              kind: "file-operation",
              facts: { kind: "delete", projectId: project.project.id, path },
            },
          ],
          matches: 1,
        })),
      )
    }),

  /**
   * Propose moving/renaming a source file. The move is self-contained: the
   * moved content carries rewrites of the file's own relative imports, and
   * Text Edits update importers across the project so their specifiers keep
   * resolving to the moved module.
   */
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
      const moveEvidence = `file:move:${project.project.id}:${sourcePath}->${targetPath}`
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
            facts: {
              kind: "move",
              projectId: project.project.id,
              path: sourcePath,
              toPath: targetPath,
            },
          },
        ],
        matches: 1,
      }

      const fromBase = stripModuleExtension(sourcePath)
      const toBase = stripModuleExtension(targetPath)
      const importEdits: Array<ProposedEdit> = []
      const owned = yield* project.files
      let movedContent = source

      for (const projectFile of owned) {
        const file = yield* projectFile.sourceFile
        const relFile = projectFile.path
        const replacements = specifierReplacements(
          file,
          relFile,
          sourcePath,
          targetPath,
          fromBase,
          toBase,
        )
        if (relFile === sourcePath) {
          movedContent = applySpecifierReplacements(source, replacements)
          continue
        }
        for (const replacement of replacements) {
          const importEvidenceId = `import:move-target:${project.project.id}:${relFile}:${replacement.start}-${replacement.end}`
          importEdits.push({
            projectId: project.project.id,
            fileName: relFile,
            start: replacement.start,
            end: replacement.end,
            expectedTextHash: textHash(file.text.slice(replacement.start, replacement.end)),
            newText: replacement.newText,
            evidenceIds: [importEvidenceId],
          })
        }
      }

      const movedDraft: Draft = {
        ...fileOpDraft,
        fileOperations: (fileOpDraft.fileOperations ?? []).map((operation) =>
          operation.kind === "move" ? { ...operation, content: movedContent } : operation,
        ),
      }
      const importDraft: Draft = {
        edits: importEdits,
        evidence: importEdits.flatMap((edit) =>
          edit.evidenceIds.map((id) => ({
            id,
            kind: "file-import-rewrite",
            facts: {
              projectId: edit.projectId,
              fileName: edit.fileName,
              target: targetPath,
            },
          })),
        ),
        matches: importEdits.length,
      }
      return concat(movedDraft, importDraft)
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
