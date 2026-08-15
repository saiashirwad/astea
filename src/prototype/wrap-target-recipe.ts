/** PROTOTYPE — one complete semantic Transformation Recipe. */
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Effect, Stream } from "effect"
import { isObjectLiteralExpression } from "typescript/unstable/ast/is"
import { textHash } from "./edits.ts"
import { finalizePlan, type EvidenceRecord, type PlanInput, type TransformationPlan } from "./plan.ts"
import { isWithinProject, projectRelativePath } from "./project-path.ts"
import {
  calls,
  collect,
  type QueryContractError,
  resolvesToSymbol,
  symbolAtPosition,
  whereBatched,
} from "./semantic-query.ts"
import { NativeCompilerError } from "./native-compiler.ts"
import type { ProjectSnapshot, ProjectSnapshotError } from "./workspace-snapshot.ts"

export interface WrapTargetResult {
  readonly plan: TransformationPlan
  readonly matchCount: number
}

const readText = (fileName: string): Effect.Effect<string, NativeCompilerError> => Effect.tryPromise({
  try: () => Fs.readFile(fileName, "utf8"),
  catch: (cause) => new NativeCompilerError({ operation: "read recipe input", cause }),
})

export const wrapTargetCandidates = (
  project: ProjectSnapshot,
  libraryFileName: string,
) => Effect.gen(function*() {
  const libraryText = yield* readText(libraryFileName)
  const position = libraryText.indexOf("target(input")
  const target = yield* symbolAtPosition(project, libraryFileName, position)
  if (target === undefined || target.name !== "target") {
    return yield* Effect.die(new Error(`Target symbol not found in ${libraryFileName}`))
  }
  return yield* calls(project).pipe(
    whereBatched(resolvesToSymbol(project, target)),
    Stream.filter((selection) => {
      const argument = selection.value.arguments[0]
      return selection.value.arguments.length === 1 &&
        argument !== undefined &&
        !isObjectLiteralExpression(argument)
    }),
    collect,
  )
})

export const buildWrapTargetPlan = (
  project: ProjectSnapshot,
  projectRoot: string,
): Effect.Effect<
  WrapTargetResult,
  ProjectSnapshotError | QueryContractError | import("./plan.ts").PlanBuildError
> =>
  Effect.gen(function*() {
    const libraryFileName = Path.join(projectRoot, "src/library.ts")
    const selections = yield* wrapTargetCandidates(project, libraryFileName)
    const edits: Array<PlanInput["edits"][number]> = []
    const evidence: Array<EvidenceRecord> = []

    for (const selection of selections) {
      const call = selection.value
      const argument = call.arguments[0]!
      const sourceFile = call.getSourceFile()
      const fileName = projectRelativePath(projectRoot, sourceFile.fileName)
      const sourceText = yield* readText(sourceFile.fileName)
      const start = argument.getStart(sourceFile)
      const end = argument.getEnd()
      const evidenceId = `selection:${fileName}:${selection.start}`
      const newText = `{ value: ${argument.getText(sourceFile)} }`
      edits.push({
        projectId: "app",
        fileName,
        start,
        end,
        expectedTextHash: textHash(sourceText.slice(start, end)),
        newText,
        evidenceIds: [evidenceId],
      })
      evidence.push({
        id: evidenceId,
        kind: "semantic-selection",
        facts: {
          fileName,
          start: selection.start,
          end: selection.end,
          symbol: "target",
          criteria: selection.evidence.map((item) => item.criterion),
        },
      })
    }

    const ownedFileNames = (yield* project.sourceFileNames()).filter((fileName) =>
      isWithinProject(projectRoot, fileName))
    const fingerprintFiles = [...new Set([
      Path.join(projectRoot, "tsconfig.json"),
      ...ownedFileNames,
    ])].sort()
    const sources = yield* Effect.all(fingerprintFiles.map((absolute) => readText(absolute).pipe(
      Effect.map((content) => ({
        projectId: "app",
        fileName: projectRelativePath(projectRoot, absolute),
        hash: textHash(content),
      })),
    )))

    const plan = yield* finalizePlan({
      recipe: {
        name: "wrap-target-input",
        version: "1.0.0",
        implementationHash: textHash("wrap-target-input/v1"),
        options: { propertyName: "value" },
      },
      toolchain: {
        systemVersion: "0.0.0-prototype",
        typescriptVersion: "7.0.2",
        effectVersion: "4.0.0-rc.109",
      },
      projects: [{ id: "app", configFileName: "tsconfig.json" }],
      sources,
      edits,
      evidence,
      policies: {
        matchCount: { min: 2, max: 2 },
        maxAffectedFiles: 2,
        diagnostics: "no-new-errors",
        idempotence: "required",
      },
    })
    return { plan, matchCount: selections.length }
  })
