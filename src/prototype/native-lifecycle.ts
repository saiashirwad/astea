/**
 * PROTOTYPE — executable observations about TypeScript 7 snapshot behavior.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Scope } from "effect"
import type { FileSystem } from "typescript/unstable/fs"
import { SyntaxKind, TokenFlags, type SourceFile, type VariableStatement } from "typescript/unstable/ast"
import {
  createNumericLiteral,
  updateVariableDeclaration,
  updateVariableDeclarationList,
  updateVariableStatement,
} from "typescript/unstable/ast/factory"
import { isVariableStatement } from "typescript/unstable/ast/is"
import type { Program, Snapshot, Symbol as NativeSymbol } from "typescript/unstable/async"
import { NativeCompiler, NativeCompilerError, nativeRequest } from "./native-compiler.ts"

const fixtureSource = fileURLToPath(new URL("../../fixtures/basic/", import.meta.url))

export interface LifecycleFixture {
  readonly root: string
  readonly configFileName: string
  readonly changedFileName: string
  readonly stableFileName: string
  readonly originalText: string
  readonly changedText: string
  readonly overlay: FileSystem
  readonly setOverlay: (fileName: string, text: string) => void
}

export interface LifecycleReport {
  readonly firstSnapshotId: number
  readonly secondSnapshotId: number
  readonly snapshotsHaveDistinctIds: boolean
  readonly firstSnapshotStillQueryableAfterUpdate: boolean
  readonly oldSemanticDiagnosticCount: number
  readonly newSemanticDiagnosticCount: number
  readonly changedSourceNodeWasReplaced: boolean
  readonly unchangedSourceNodeWasRetained: boolean
  readonly repeatedSymbolIdentityWithinSnapshot: boolean
  readonly batchedSymbolIdentityWithinSnapshot: boolean
  readonly symbolIdentityChangesAcrossSnapshots: boolean
  readonly repeatedTypeIdentityWithinSnapshot: boolean
  readonly typeIdentityChangesAcrossSnapshots: boolean
  readonly singleLookupRequestCount: number
  readonly batchedLookupRequestCount: number
  readonly synthesizedFragment: string
  readonly diskRemainedUnchanged: boolean
  readonly disposedSnapshotRejectsAccess: boolean
  readonly disposedProgramRejectsRemoteQuery: boolean
  readonly decodedSourceTextSurvivesDisposal: boolean
  readonly emitterCanPrintDecodedNodeAfterDisposal: boolean
  readonly requestsSinceLastTimingReset: number
  readonly sourceFilesFetchedSinceLastTimingReset: number
  readonly nodesFetchedSinceLastTimingReset: number
  readonly nodesMaterializedSinceLastTimingReset: number
}

export const makeLifecycleFixture: Effect.Effect<LifecycleFixture, NativeCompilerError, Scope.Scope> =
  Effect.acquireRelease(
    nativeRequest("create lifecycle fixture", async () => {
      const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "teatime-native-lifecycle-"))
      await Fs.cp(fixtureSource, root, { recursive: true })

      const configFileName = Path.join(root, "tsconfig.json")
      const changedFileName = Path.join(root, "src/index.ts")
      const stableFileName = Path.join(root, "src/stable.ts")
      const originalText = await Fs.readFile(changedFileName, "utf8")
      const changedText = originalText.replace(
        "export const answer =",
        "export const answer: string =",
      )
      const overrides = new Map<string, string>()

      return {
        root,
        configFileName,
        changedFileName,
        stableFileName,
        originalText,
        changedText,
        overlay: {
          readFile: (fileName) => overrides.get(fileName),
        },
        setOverlay: (fileName, text) => {
          overrides.set(fileName, text)
        },
      }
    }),
    (fixture) => Effect.promise(() => Fs.rm(fixture.root, { recursive: true, force: true })),
  )

const requireProject = (snapshot: Snapshot, configFileName: string) => {
  const project = snapshot.getProject(configFileName)
  if (project === undefined) {
    throw new NativeCompilerError({
      operation: "getProject",
      cause: new Error(`Project not found: ${configFileName}`),
    })
  }
  return project
}

const requireSourceFile = async (program: Program, fileName: string): Promise<SourceFile> => {
  const sourceFile = await program.getSourceFile(fileName)
  if (sourceFile === undefined) {
    throw new Error(`Source file not found: ${fileName}`)
  }
  return sourceFile
}

const requireSymbol = async (
  symbol: NativeSymbol | undefined,
  fileName: string,
): Promise<NativeSymbol> => {
  if (symbol === undefined) {
    throw new Error(`Symbol not found in ${fileName}`)
  }
  return symbol
}

const printHybridFragment = async (
  sourceFile: SourceFile,
  printNode: (node: VariableStatement) => Promise<string>,
): Promise<string> => {
  const statement = sourceFile.statements.find((candidate): candidate is VariableStatement =>
    isVariableStatement(candidate) &&
    candidate.declarationList.declarations.some((declaration) => declaration.name.getText(sourceFile) === "answer"))

  if (statement === undefined) {
    throw new Error("Could not find the answer variable statement")
  }

  const declaration = statement.declarationList.declarations[0]
  const updatedDeclaration = updateVariableDeclaration(
    declaration,
    declaration.name,
    declaration.exclamationToken,
    declaration.type,
    createNumericLiteral("43", TokenFlags.None),
  )
  const updatedList = updateVariableDeclarationList(statement.declarationList, [updatedDeclaration])
  const updatedStatement = updateVariableStatement(statement, statement.modifiers, updatedList)

  return printNode(updatedStatement)
}

export const inspectNativeLifecycle = (
  fixture: LifecycleFixture,
): Effect.Effect<LifecycleReport, NativeCompilerError, NativeCompiler> => Effect.gen(function*() {
  const compiler = yield* NativeCompiler
  let disposedSnapshot: Snapshot | undefined
  let disposedProgram: Program | undefined
  let disposedSourceFile: SourceFile | undefined
  let printDisposedNode: (() => Promise<string>) | undefined

  const observed = yield* Effect.scoped(Effect.gen(function*() {
    const firstSnapshot = yield* compiler.openSnapshot({
      openProjects: [fixture.configFileName],
    })
    const firstProject = requireProject(firstSnapshot, fixture.configFileName)
    const [firstSourceFile, firstStableFile, oldDiagnostics] = yield* nativeRequest(
      "read first snapshot",
      () => Promise.all([
        requireSourceFile(firstProject.program, fixture.changedFileName),
        requireSourceFile(firstProject.program, fixture.stableFileName),
        firstProject.program.getSemanticDiagnostics(),
      ]),
    )

    const symbolPosition = fixture.originalText.indexOf("add")
    yield* compiler.resetTiming()
    const firstSymbol = yield* nativeRequest("first symbol lookup", () =>
      firstProject.checker.getSymbolAtPosition(fixture.changedFileName, symbolPosition))
    const repeatedSymbol = yield* nativeRequest("repeated symbol lookup", () =>
      firstProject.checker.getSymbolAtPosition(fixture.changedFileName, symbolPosition))
    const singleLookupTiming = yield* compiler.getTiming()

    yield* compiler.resetTiming()
    const batchedSymbols = yield* nativeRequest("batched symbol lookup", () =>
      firstProject.checker.getSymbolAtPosition(fixture.changedFileName, [symbolPosition, symbolPosition]))
    const batchedLookupTiming = yield* compiler.getTiming()
    const requiredFirstSymbol = yield* nativeRequest("require first symbol", () =>
      requireSymbol(firstSymbol, fixture.changedFileName))
    const [firstType, repeatedType] = yield* nativeRequest("repeated type lookup", () =>
      Promise.all([
        firstProject.checker.getTypeOfSymbol(requiredFirstSymbol),
        firstProject.checker.getTypeOfSymbol(requiredFirstSymbol),
      ]))

    fixture.setOverlay(fixture.changedFileName, fixture.changedText)
    const secondSnapshot = yield* compiler.openSnapshot({
      fileChanges: { changed: [fixture.changedFileName] },
    })
    const secondProject = requireProject(secondSnapshot, fixture.configFileName)
    const [secondSourceFile, secondStableFile, newDiagnostics, oldDiagnosticsAfterUpdate] = yield* nativeRequest(
      "read second snapshot",
      () => Promise.all([
        requireSourceFile(secondProject.program, fixture.changedFileName),
        requireSourceFile(secondProject.program, fixture.stableFileName),
        secondProject.program.getSemanticDiagnostics(),
        firstProject.program.getSemanticDiagnostics(),
      ]),
    )
    const secondSymbol = yield* nativeRequest("second snapshot symbol lookup", () =>
      secondProject.checker.getSymbolAtPosition(fixture.changedFileName, symbolPosition))
    const requiredSecondSymbol = yield* nativeRequest("require second symbol", () =>
      requireSymbol(secondSymbol, fixture.changedFileName))
    const secondType = yield* nativeRequest("second snapshot type lookup", () =>
      secondProject.checker.getTypeOfSymbol(requiredSecondSymbol))
    const synthesizedFragment = yield* nativeRequest("print hybrid fragment", () =>
      printHybridFragment(
        firstSourceFile,
        (node) => firstProject.emitter.printNode(node),
      ))
    const diskText = yield* nativeRequest("read unchanged disk source", () =>
      Fs.readFile(fixture.changedFileName, "utf8"))

    disposedSnapshot = firstSnapshot
    disposedProgram = firstProject.program
    disposedSourceFile = firstSourceFile
    printDisposedNode = () => firstProject.emitter.printNode(firstSourceFile.statements[1])

    return {
      firstSnapshotId: firstSnapshot.id,
      secondSnapshotId: secondSnapshot.id,
      snapshotsHaveDistinctIds: firstSnapshot.id !== secondSnapshot.id,
      firstSnapshotStillQueryableAfterUpdate: oldDiagnosticsAfterUpdate.length === oldDiagnostics.length,
      oldSemanticDiagnosticCount: oldDiagnostics.length,
      newSemanticDiagnosticCount: newDiagnostics.length,
      changedSourceNodeWasReplaced: firstSourceFile !== secondSourceFile,
      unchangedSourceNodeWasRetained: firstStableFile === secondStableFile,
      repeatedSymbolIdentityWithinSnapshot: firstSymbol !== undefined && firstSymbol === repeatedSymbol,
      batchedSymbolIdentityWithinSnapshot:
        batchedSymbols[0] !== undefined && batchedSymbols[0] === batchedSymbols[1],
      symbolIdentityChangesAcrossSnapshots:
        firstSymbol !== undefined && secondSymbol !== undefined && firstSymbol !== secondSymbol,
      repeatedTypeIdentityWithinSnapshot: firstType !== undefined && firstType === repeatedType,
      typeIdentityChangesAcrossSnapshots:
        firstType !== undefined && secondType !== undefined && firstType !== secondType,
      singleLookupRequestCount: singleLookupTiming.totals.requestCount,
      batchedLookupRequestCount: batchedLookupTiming.totals.requestCount,
      synthesizedFragment,
      diskRemainedUnchanged: diskText === fixture.originalText,
    }
  }))

  const disposedSnapshotRejectsAccess = yield* Effect.sync(() => {
    try {
      disposedSnapshot?.getProjects()
      return false
    } catch {
      return true
    }
  })
  const disposedProgramRejectsRemoteQuery = yield* nativeRequest(
    "query disposed program",
    () => disposedProgram?.getSemanticDiagnostics() ?? Promise.resolve([]),
  ).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false }))
  const decodedSourceTextSurvivesDisposal = disposedSourceFile?.text === fixture.originalText
  const emitterCanPrintDecodedNodeAfterDisposal = yield* nativeRequest(
    "print decoded node after snapshot disposal",
    () => printDisposedNode?.() ?? Promise.reject(new Error("No disposed node was captured")),
  ).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
  const timing = yield* compiler.getTiming()

  return {
    ...observed,
    disposedSnapshotRejectsAccess,
    disposedProgramRejectsRemoteQuery,
    decodedSourceTextSurvivesDisposal,
    emitterCanPrintDecodedNodeAfterDisposal,
    requestsSinceLastTimingReset: timing.totals.requestCount,
    sourceFilesFetchedSinceLastTimingReset: timing.totals.sourceFilesFetched,
    nodesFetchedSinceLastTimingReset: timing.totals.nodesFetched,
    nodesMaterializedSinceLastTimingReset: timing.totals.nodesMaterialized,
  }
})
