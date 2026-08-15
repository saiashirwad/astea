import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { finalizePlan, parsePlan, serializePlan, type PlanInput } from "./plan.ts"

const input = (): PlanInput => ({
  recipe: { name: "wrap-target", version: "1.0.0", implementationHash: "recipe-hash", options: {} },
  toolchain: { systemVersion: "0.0.0", typescriptVersion: "7.0.2", effectVersion: "4.0.0-rc.109" },
  projects: [{ id: "app", configFileName: "tsconfig.json" }],
  sources: [
    { projectId: "app", fileName: "src/b.ts", hash: "b-hash" },
    { projectId: "app", fileName: "src/a.ts", hash: "a-hash" },
  ],
  edits: [{
    projectId: "app",
    fileName: "src/a.ts",
    start: 4,
    end: 5,
    expectedTextHash: "old-hash",
    newText: "next",
    evidenceIds: ["selection:1"],
  }],
  evidence: [{ id: "selection:1", kind: "selection", facts: { symbol: "target", matched: true } }],
  policies: {
    matchCount: { min: 1, max: 1 },
    maxAffectedFiles: 1,
    diagnostics: "no-new-errors",
    idempotence: "required",
  },
})

describe("durable Transformation Plan prototype", () => {
  it("canonicalizes ordering and round-trips across a JSON process boundary", async () => {
    const leftInput = input()
    const rightInput = { ...input(), sources: [...input().sources].reverse() }
    const [left, right] = await Effect.runPromise(Effect.all([
      finalizePlan(leftInput),
      finalizePlan(rightInput),
    ]))

    expect(left.planId).toBe(right.planId)
    expect(serializePlan(left)).toBe(serializePlan(right))
    await expect(Effect.runPromise(parsePlan(serializePlan(left)))).resolves.toEqual(left)
    expect(serializePlan(left)).not.toContain("/Users/")
  })

  it("rejects a persisted plan whose content no longer matches its identity", async () => {
    const plan = await Effect.runPromise(finalizePlan(input()))
    const tampered = serializePlan(plan).replace("next", "other")
    const exit = await Effect.runPromiseExit(parsePlan(tampered))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(String(exit.cause)).toContain("PlanDecodeError")
  })
})
