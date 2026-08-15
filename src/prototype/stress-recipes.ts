/** PROTOTYPE — representative import- and symbol-oriented recipes for API stress testing. */
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Data, Effect, Stream } from "effect"
import type { ImportDeclaration } from "typescript/unstable/ast"
import { isIdentifier, isImportDeclaration, isStringLiteral } from "typescript/unstable/ast/is"
import { textHash } from "./edits.ts"
import { NativeCompilerError } from "./native-compiler.ts"
import { finalizePlan, type EvidenceRecord, type PlanInput, type TransformationPlan } from "./plan.ts"
import { isWithinProject, projectRelativePath } from "./project-path.ts"
import {
  collect,
  nodes,
  resolvesNodeToSymbol,
  symbolAtPosition,
  whereBatched,
} from "./semantic-query.ts"
import type { ProjectSnapshot } from "./workspace-snapshot.ts"

export class RenameConflict extends Data.TaggedError("RenameConflict")<{
  readonly fileName: string
  readonly oldName: string
  readonly newName: string
}> {}

const readText = (fileName: string): Effect.Effect<string, NativeCompilerError> => Effect.tryPromise({
  try: () => Fs.readFile(fileName, "utf8"),
  catch: (cause) => new NativeCompilerError({ operation: "read stress recipe input", cause }),
})

const sourceFingerprints = (
  project: ProjectSnapshot,
  projectRoot: string,
) => Effect.gen(function*() {
  const owned = (yield* project.sourceFileNames()).filter((fileName) =>
    isWithinProject(projectRoot, fileName))
  const files = [...new Set([Path.join(projectRoot, "tsconfig.json"), ...owned])].sort()
  return yield* Effect.all(files.map((absolute) => readText(absolute).pipe(Effect.map((content) => ({
    projectId: "app",
    fileName: projectRelativePath(projectRoot, absolute),
    hash: textHash(content),
  })))))
})

const finishPlan = (
  project: ProjectSnapshot,
  projectRoot: string,
  recipe: PlanInput["recipe"],
  edits: PlanInput["edits"],
  evidence: ReadonlyArray<EvidenceRecord>,
  expectedMatches: number,
): Effect.Effect<TransformationPlan, NativeCompilerError | import("./plan.ts").PlanBuildError | import("./workspace-snapshot.ts").ProjectSnapshotError> =>
  Effect.gen(function*() {
    return yield* finalizePlan({
      recipe,
      toolchain: {
        systemVersion: "0.0.0-prototype",
        typescriptVersion: "7.0.2",
        effectVersion: "4.0.0-rc.109",
      },
      projects: [{ id: "app", configFileName: "tsconfig.json" }],
      sources: yield* sourceFingerprints(project, projectRoot),
      edits,
      evidence,
      policies: {
        matchCount: { min: expectedMatches, max: expectedMatches },
        maxAffectedFiles: expectedMatches,
        diagnostics: "no-new-errors",
        idempotence: "required",
      },
    })
  })

export const importMigrationCandidates = (
  project: ProjectSnapshot,
  from: string,
) => nodes(project, isImportDeclaration).pipe(
  Stream.filter((selection) =>
    isStringLiteral(selection.value.moduleSpecifier) && selection.value.moduleSpecifier.text === from),
  collect,
)

export const buildImportMigrationPlan = (
  project: ProjectSnapshot,
  projectRoot: string,
  options: { readonly from: string; readonly to: string; readonly expectedMatches: number },
) => Effect.gen(function*() {
  const selections = yield* importMigrationCandidates(project, options.from)
  const edits: Array<PlanInput["edits"][number]> = []
  const evidence: Array<EvidenceRecord> = []
  for (const selection of selections) {
    const declaration: ImportDeclaration = selection.value
    const sourceFile = declaration.getSourceFile()
    const sourceText = yield* readText(sourceFile.fileName)
    const literal = declaration.moduleSpecifier
    const start = literal.getStart(sourceFile)
    const end = literal.getEnd()
    const oldText = sourceText.slice(start, end)
    const quote = oldText[0] === "'" ? "'" : "\""
    const fileName = projectRelativePath(projectRoot, sourceFile.fileName)
    const evidenceId = `import:${fileName}:${start}`
    edits.push({
      projectId: "app",
      fileName,
      start,
      end,
      expectedTextHash: textHash(oldText),
      newText: `${quote}${options.to}${quote}`,
      evidenceIds: [evidenceId],
    })
    evidence.push({
      id: evidenceId,
      kind: "import-migration",
      facts: { fileName, from: options.from, to: options.to },
    })
  }
  return {
    plan: yield* finishPlan(
      project,
      projectRoot,
      {
        name: "migrate-import-source",
        version: "1.0.0",
        implementationHash: textHash("migrate-import-source/v1"),
        options,
      },
      edits,
      evidence,
      options.expectedMatches,
    ),
    matchCount: selections.length,
  }
})

export const symbolRenameCandidates = (
  project: ProjectSnapshot,
  declarationFileName: string,
  oldName: string,
) => Effect.gen(function*() {
  const declarationText = yield* readText(declarationFileName)
  const targetPosition = declarationText.indexOf(oldName)
  if (targetPosition < 0) return []
  const target = yield* symbolAtPosition(project, declarationFileName, targetPosition)
  if (target === undefined) return []
  return yield* nodes(project, isIdentifier).pipe(
    whereBatched(resolvesNodeToSymbol(project, target)),
    Stream.filter((selection) => selection.value.text === oldName),
    collect,
  )
})

export const buildSymbolRenamePlan = (
  project: ProjectSnapshot,
  projectRoot: string,
  options: {
    readonly declarationFileName: string
    readonly oldName: string
    readonly newName: string
    readonly expectedMatches: number
  },
) => Effect.gen(function*() {
  const declarationText = yield* readText(options.declarationFileName)
  if (declarationText.includes(`function ${options.newName}`)) {
    return yield* new RenameConflict({
      fileName: options.declarationFileName,
      oldName: options.oldName,
      newName: options.newName,
    })
  }
  const selections = yield* symbolRenameCandidates(
    project,
    options.declarationFileName,
    options.oldName,
  )
  const edits: Array<PlanInput["edits"][number]> = []
  const evidence: Array<EvidenceRecord> = []
  for (const selection of selections) {
    const identifier = selection.value
    const sourceFile = identifier.getSourceFile()
    const sourceText = yield* readText(sourceFile.fileName)
    const start = identifier.getStart(sourceFile)
    const end = identifier.getEnd()
    const fileName = projectRelativePath(projectRoot, sourceFile.fileName)
    const evidenceId = `rename:${fileName}:${start}`
    edits.push({
      projectId: "app",
      fileName,
      start,
      end,
      expectedTextHash: textHash(sourceText.slice(start, end)),
      newText: options.newName,
      evidenceIds: [evidenceId],
    })
    evidence.push({
      id: evidenceId,
      kind: "symbol-rename",
      facts: {
        fileName,
        oldName: options.oldName,
        newName: options.newName,
        canonicalSymbol: options.oldName,
      },
    })
  }
  return {
    plan: yield* finishPlan(
      project,
      projectRoot,
      {
        name: "rename-canonical-symbol",
        version: "1.0.0",
        implementationHash: textHash("rename-canonical-symbol/v1"),
        options: {
          declarationFileName: projectRelativePath(projectRoot, options.declarationFileName),
          oldName: options.oldName,
          newName: options.newName,
        },
      },
      edits,
      evidence,
      options.expectedMatches,
    ),
    matchCount: selections.length,
  }
})
