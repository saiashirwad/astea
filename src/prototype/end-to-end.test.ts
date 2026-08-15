import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  applicationLayer,
  PlanApplication,
  previewPlan,
  verifyPreview,
} from "./verification.ts"
import { buildWrapTargetPlan, wrapTargetCandidates } from "./wrap-target-recipe.ts"
import { ConfiguredProject, layer, Workspace, WorkspaceSnapshot } from "./workspace-snapshot.ts"

const fixtureSource = fileURLToPath(new URL("../../fixtures/recipe/", import.meta.url))

describe("end-to-end Transformation Recipe", () => {
  it("queries by symbol, plans minimal edits, verifies virtually, and applies explicitly", async () => {
    const root = await Fs.mkdtemp("/tmp/teatime-recipe-")
    await Fs.cp(fixtureSource, root, { recursive: true })
    const configFileName = Path.join(root, "tsconfig.json")
    const configured = ConfiguredProject.make(configFileName)
    const overlays = new Map<string, string>()

    try {
      const initial = await Effect.runPromise(Workspace.use((workspace) =>
        workspace.withSnapshot({}, Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          const project = yield* snapshot.project(configured)
          const built = yield* buildWrapTargetPlan(project, root)
          return {
            ...built,
            baselineErrors: yield* project.semanticDiagnosticCount(),
          }
        }))).pipe(Effect.provide(layer(
        { projects: [configured] },
        { cwd: root },
      ))))

      const preview = await Effect.runPromise(previewPlan(initial.plan, root))
      for (const file of preview.files) overlays.set(Path.join(root, file.fileName), file.afterText)

      // Verification gets a fresh compiler authority over a complete virtual
      // filesystem. It cannot inherit decoded nodes or semantic caches from planning.
      const proposed = await Effect.runPromise(Workspace.use((workspace) =>
        workspace.withSnapshot({}, Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          const project = yield* snapshot.project(configured)
          const candidates = yield* wrapTargetCandidates(project, Path.join(root, "src/library.ts"))
          return {
            errors: yield* project.semanticDiagnosticCount(),
            secondMatchCount: candidates.length,
            candidateTexts: candidates.map((selection) => selection.value.getText()),
          }
        }))).pipe(Effect.provide(layer(
        { projects: [configured] },
        { cwd: root, fs: { readFile: (fileName) => {
          const exact = overlays.get(fileName)
          if (exact !== undefined) return exact
          for (const [plannedFileName, content] of overlays) {
            if (fileName.endsWith(Path.relative(root, plannedFileName))) return content
          }
          return undefined
        } } },
      ))))

      expect(initial.matchCount).toBe(2)
      expect(preview.files).toHaveLength(2)
      expect(proposed.errors).toBe(initial.baselineErrors)
      expect(proposed.candidateTexts).toEqual([])

      const verified = await Effect.runPromise(verifyPreview(initial.plan, preview, {
        actualMatches: initial.matchCount,
        baselineErrorCount: initial.baselineErrors,
        proposedErrorCount: proposed.errors,
        secondPlanEditCount: proposed.secondMatchCount,
      }))

      const beforeConsumer = await Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
      expect(beforeConsumer).toContain("renamed(/* keep this comment */ 1)")
      const receipt = await Effect.runPromise(PlanApplication.use((application) =>
        application.apply(verified)).pipe(Effect.provide(applicationLayer(root))))
      const afterConsumer = await Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
      const afterReexport = await Fs.readFile(Path.join(root, "src/reexport-consumer.ts"), "utf8")

      expect(receipt.outputs).toHaveLength(2)
      expect(afterConsumer).toContain("renamed(/* keep this comment */ { value: 1 })")
      expect(afterConsumer).toContain("const first  =")
      expect(afterConsumer).toContain("other(2)")
      expect(afterConsumer).toContain("local.target(3)")
      expect(afterReexport).toContain("publicTarget({ value: 4 })")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
})
