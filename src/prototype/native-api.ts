import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { API } from "typescript/unstable/async"

export interface NativeProjectSummary {
  readonly configFileName: string
  readonly sourceFileNames: ReadonlyArray<string>
  readonly semanticDiagnosticCount: number
}

const fixtureRoot = fileURLToPath(new URL("../../fixtures/basic/", import.meta.url))
const configFileName = Path.join(fixtureRoot, "tsconfig.json")

export const inspectNativeProject: Effect.Effect<NativeProjectSummary, Error> = Effect.tryPromise({
  try: async () => {
    const api = new API({ cwd: fixtureRoot })

    try {
      const snapshot = await api.updateSnapshot({ openProjects: [configFileName] })

      try {
        const project = snapshot.getProject(configFileName)
        if (project === undefined) {
          throw new Error(`TypeScript did not open the fixture project at ${configFileName}`)
        }

        const [sourceFileNames, semanticDiagnostics] = await Promise.all([
          project.program.getSourceFileNames(),
          project.program.getSemanticDiagnostics(),
        ])

        return {
          configFileName: project.configFileName,
          sourceFileNames,
          semanticDiagnosticCount: semanticDiagnostics.length,
        }
      } finally {
        await snapshot.dispose()
      }
    } finally {
      await api.close()
    }
  },
  catch: (cause) => cause instanceof Error ? cause : new Error("Native TypeScript API experiment failed", { cause }),
})
