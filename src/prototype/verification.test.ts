import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { textHash } from "./edits.ts"
import { finalizePlan, type PlanInput } from "./plan.ts"
import {
  applicationLayer,
  PlanApplication,
  previewPlan,
  verifyPreview,
} from "./verification.ts"

describe("verification and application prototype", () => {
  it("previews without writes, requires verification, applies explicitly, and rejects staleness", async () => {
    const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "teatime-application-"))
    const sourcePath = Path.join(root, "src/index.ts")
    await Fs.mkdir(Path.dirname(sourcePath), { recursive: true })
    const original = "export const answer = 41\n"
    await Fs.writeFile(sourcePath, original)
    try {
      const start = original.indexOf("41")
      const input: PlanInput = {
        recipe: { name: "answer", version: "1", implementationHash: "recipe", options: {} },
        toolchain: { systemVersion: "0", typescriptVersion: "7.0.2", effectVersion: "4.0.0-rc.109" },
        projects: [{ id: "app", configFileName: "tsconfig.json" }],
        sources: [{ projectId: "app", fileName: "src/index.ts", hash: textHash(original) }],
        edits: [{
          projectId: "app",
          fileName: "src/index.ts",
          start,
          end: start + 2,
          expectedTextHash: textHash("41"),
          newText: "42",
          evidenceIds: ["answer"],
        }],
        evidence: [{ id: "answer", kind: "selection", facts: { old: 41, next: 42 } }],
        policies: {
          matchCount: { min: 1, max: 1 },
          maxAffectedFiles: 1,
          diagnostics: "no-new-errors",
          idempotence: "required",
        },
      }
      const plan = await Effect.runPromise(finalizePlan(input))
      const preview = await Effect.runPromise(previewPlan(plan, root))
      expect(await Fs.readFile(sourcePath, "utf8")).toBe(original)

      const verified = await Effect.runPromise(verifyPreview(plan, preview, {
        actualMatches: 1,
        baselineErrorCount: 0,
        proposedErrorCount: 0,
        secondPlanEditCount: 0,
      }))
      const receipt = await Effect.runPromise(PlanApplication.use((service) => service.apply(verified)).pipe(
        Effect.provide(applicationLayer(root)),
      ))
      expect(receipt.outputs).toHaveLength(1)
      expect(await Fs.readFile(sourcePath, "utf8")).toBe("export const answer = 42\n")

      const staleExit = await Effect.runPromiseExit(previewPlan(plan, root))
      expect(staleExit._tag).toBe("Failure")
      if (staleExit._tag === "Failure") expect(String(staleExit.cause)).toContain("StalePlanError")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
})
