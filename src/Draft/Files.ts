import { path as Path } from "../platform/node.ts"
import { Effect } from "effect"
import { SyntaxKind, type Node, type SourceFile, type StringLiteral } from "typescript/unstable/ast"
import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportExpression,
  isImportTypeNode,
  isLiteralTypeNode,
  isStringLiteral,
} from "typescript/unstable/ast/is"
import { textHash } from "../Edit/Hash.ts"
import type { QueryContractError } from "../Query/index.ts"
import {
  InvalidProjectRelativePath,
  parseProjectRelativePath,
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
          const importEvidenceId = `import:move-target:${relFile}:${replacement.start}-${replacement.end}`
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
            facts: { fileName: edit.fileName, target: targetPath },
          })),
        ),
        matches: importEdits.length,
      }
      return concat(movedDraft, importDraft)
    }),
}

const moduleExtension = /\.(ts|tsx|js|jsx)$/

const stripModuleExtension = (value: string): string => value.replace(moduleExtension, "")

const specifierExtension = (specText: string): string => {
  const match = moduleExtension.exec(specText)
  return match?.[0] ?? ""
}

const asModuleSpecifier = (value: string): string => value.split(Path.sep).join("/")

const isRelativeSpecifier = (specText: string): boolean =>
  specText.startsWith("./") || specText.startsWith("../")

const resolvedSpecifierPath = (fileDir: string, specText: string): string =>
  Path.normalize(Path.join(fileDir, specText))

const refersToMovedModule = (resolved: string, fromBase: string, sourcePath: string): boolean => {
  const stripped = stripModuleExtension(resolved)
  return stripped === fromBase || stripped === `./${fromBase}` || stripped === sourcePath
}

const quotedSpecifier = (file: SourceFile, specifier: StringLiteral, next: string): string => {
  const start = specifier.getStart(file)
  const quote = file.text[start] === "'" ? "'" : '"'
  return `${quote}${next}${quote}`
}

const rewriteRelativeSpecifier = (
  specText: string,
  fromDir: string,
  toDir: string,
): string | undefined => {
  if (!isRelativeSpecifier(specText) || fromDir === toDir) return undefined
  const next = asModuleSpecifier(Path.relative(toDir, resolvedSpecifierPath(fromDir, specText)))
  const withDot = next.startsWith(".") ? next : `./${next}`
  return withDot === specText ? undefined : withDot
}

const rewriteMovedTargetSpecifier = (
  specText: string,
  fileDir: string,
  toBase: string,
): string | undefined => {
  if (!isRelativeSpecifier(specText)) return undefined
  const next = `${asModuleSpecifier(Path.relative(fileDir, toBase))}${specifierExtension(specText)}`
  const withDot = next.startsWith(".") ? next : `./${next}`
  return withDot === specText ? undefined : withDot
}

interface SpecifierReplacement {
  readonly start: number
  readonly end: number
  readonly newText: string
}

const specifierLiteral = (node: Node): StringLiteral | undefined => {
  if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier
  }
  if (
    isExportDeclaration(node) &&
    node.moduleSpecifier !== undefined &&
    isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier
  }
  if (
    isImportEqualsDeclaration(node) &&
    isExternalModuleReference(node.moduleReference) &&
    isStringLiteral(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression
  }
  if (
    isCallExpression(node) &&
    node.arguments[0] !== undefined &&
    isStringLiteral(node.arguments[0])
  ) {
    const expression = node.expression
    const isImportCall =
      expression.kind === SyntaxKind.ImportKeyword || isImportExpression(expression)
    const isRequireCall = isIdentifier(expression) && expression.text === "require"
    if (isImportCall || isRequireCall) return node.arguments[0]
  }
  if (
    isImportTypeNode(node) &&
    isLiteralTypeNode(node.argument) &&
    isStringLiteral(node.argument.literal)
  ) {
    return node.argument.literal
  }
  return undefined
}

const eachModuleSpecifier = (file: SourceFile, visit: (specifier: StringLiteral) => void): void => {
  const walk = (node: Node): void => {
    const specifier = specifierLiteral(node)
    if (specifier !== undefined) visit(specifier)
    node.forEachChild((child) => {
      walk(child)
      return undefined
    })
  }
  walk(file)
}

const specifierReplacements = (
  file: SourceFile,
  relFile: string,
  sourcePath: string,
  targetPath: string,
  fromBase: string,
  toBase: string,
): Array<SpecifierReplacement> => {
  const fileDir = Path.dirname(relFile)
  const sourceDir = Path.dirname(sourcePath)
  const targetDir = Path.dirname(targetPath)
  const replacements: Array<SpecifierReplacement> = []
  eachModuleSpecifier(file, (specifier) => {
    const specText = specifier.text
    const next =
      relFile === sourcePath
        ? rewriteRelativeSpecifier(specText, sourceDir, targetDir)
        : refersToMovedModule(resolvedSpecifierPath(fileDir, specText), fromBase, sourcePath)
          ? rewriteMovedTargetSpecifier(specText, fileDir, toBase)
          : undefined
    if (next === undefined) return
    replacements.push({
      start: specifier.getStart(file),
      end: specifier.getEnd(),
      newText: quotedSpecifier(file, specifier, next),
    })
  })
  return replacements
}

const applySpecifierReplacements = (
  source: string,
  replacements: Array<SpecifierReplacement>,
): string => {
  const ordered = [...replacements].sort((left, right) => right.start - left.start)
  let next = source
  for (const replacement of ordered) {
    next = `${next.slice(0, replacement.start)}${replacement.newText}${next.slice(replacement.end)}`
  }
  return next
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
