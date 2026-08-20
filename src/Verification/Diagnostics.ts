/** Compiler diagnostic collection and normalization. */
import { Effect } from "effect"
import { DiagnosticCategory, type Diagnostic } from "typescript/unstable/async"
import { nativeRequest } from "../Compiler/Service.ts"
import type { DiagnosticRecord } from "../Policy/index.ts"
import { WorkspaceSnapshot } from "../Workspace/index.ts"

const normalizeDiagnostic = (diagnostic: Diagnostic): DiagnosticRecord => ({
  code: diagnostic.code,
  message: diagnostic.text,
  category:
    diagnostic.category === DiagnosticCategory.Warning
      ? "warning"
      : diagnostic.category === DiagnosticCategory.Suggestion
        ? "suggestion"
        : diagnostic.category === DiagnosticCategory.Message
          ? "message"
          : "error",
  fileName: diagnostic.fileName,
  start: diagnostic.pos,
  length: diagnostic.end - diagnostic.pos,
})

const diagnosticIdentity = (diagnostic: DiagnosticRecord): string =>
  JSON.stringify([
    diagnostic.category,
    diagnostic.code,
    diagnostic.fileName ?? null,
    diagnostic.start ?? null,
    diagnostic.length ?? null,
    diagnostic.message,
  ])

const collectProjectDiagnostics = (nativeProject: {
  readonly program: {
    readonly getSyntacticDiagnostics: () => PromiseLike<ReadonlyArray<Diagnostic>>
    readonly getBindDiagnostics: () => PromiseLike<ReadonlyArray<Diagnostic>>
    readonly getSemanticDiagnostics: () => PromiseLike<ReadonlyArray<Diagnostic>>
    readonly getProgramDiagnostics: () => PromiseLike<ReadonlyArray<Diagnostic>>
    readonly getGlobalDiagnostics: () => PromiseLike<ReadonlyArray<Diagnostic>>
    readonly getConfigFileParsingDiagnostics: () => PromiseLike<ReadonlyArray<Diagnostic>>
  }
}) =>
  Effect.all([
    nativeRequest("getSyntacticDiagnostics", () => nativeProject.program.getSyntacticDiagnostics()),
    nativeRequest("getBindDiagnostics", () => nativeProject.program.getBindDiagnostics()),
    nativeRequest("getSemanticDiagnostics", () => nativeProject.program.getSemanticDiagnostics()),
    nativeRequest("getProgramDiagnostics", () => nativeProject.program.getProgramDiagnostics()),
    nativeRequest("getGlobalDiagnostics", () => nativeProject.program.getGlobalDiagnostics()),
    nativeRequest("getConfigFileParsingDiagnostics", () =>
      nativeProject.program.getConfigFileParsingDiagnostics(),
    ),
  ])

export const collectDiagnostics = Effect.gen(function* () {
  const snapshot = yield* WorkspaceSnapshot
  const allDiagnostics: Array<DiagnosticRecord> = []
  const seen = new Set<string>()

  for (const configured of snapshot.projects) {
    const project = yield* snapshot.project(configured)
    const lists = yield* project.unsafeNative((nativeProject) =>
      collectProjectDiagnostics(nativeProject),
    )
    for (const list of lists) {
      for (const diagnostic of list) {
        const record = normalizeDiagnostic(diagnostic)
        const key = diagnosticIdentity(record)
        if (seen.has(key)) continue
        seen.add(key)
        allDiagnostics.push(record)
      }
    }
  }
  return allDiagnostics
})
