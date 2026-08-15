import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { inspectNativeProject } from "./native-api.ts"

describe("native TypeScript API harness", () => {
  it("opens and checks the filesystem-backed fixture project", async () => {
    const summary = await Effect.runPromise(inspectNativeProject)

    expect(summary.configFileName).toMatch(/fixtures\/basic\/tsconfig\.json$/)
    expect(summary.sourceFileNames.some((fileName) => fileName.endsWith("/fixtures/basic/src/index.ts"))).toBe(true)
    expect(summary.semanticDiagnosticCount).toBe(0)
  })
})
