import { Effect } from "effect"
import { inspectNativeProject } from "./native-api.ts"

const summary = await Effect.runPromise(inspectNativeProject)

console.log({
  configFileName: summary.configFileName,
  sourceFileCount: summary.sourceFileNames.length,
  fixtureSourceFileName: summary.sourceFileNames.find((fileName) => fileName.endsWith("/fixtures/basic/src/index.ts")),
  semanticDiagnosticCount: summary.semanticDiagnosticCount,
})
