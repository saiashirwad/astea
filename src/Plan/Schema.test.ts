import { describe, effect, expect } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { finalizePlan, parsePlan, serializePlan } from "./index.ts"

const input = {
  recipe: { name: "test", version: "1", implementationHash: "impl", options: null },
  toolchain: { systemVersion: "1", typescriptVersion: "7", effectVersion: "4" },
  projects: [{ id: "app", configFileName: "tsconfig.json" }],
  sources: [{ projectId: "app", fileName: "src/index.ts", hash: "source" }],
  edits: [],
  evidence: [],
  policies: {
    matchCount: {},
    diagnostics: "no-new-errors" as const,
    idempotence: "not-promised" as const,
  },
}

describe("Plan schema", () => {
  effect("round-trips canonical plans with stable hashes", () => Effect.gen(function*() {
    const first = yield* finalizePlan(input)
    const second = yield* finalizePlan(input)
    expect(first.planId).toBe(second.planId)
    expect(yield* parsePlan(serializePlan(first))).toEqual(first)
  }))

  effect("rejects structurally invalid plan payloads", () => Effect.gen(function*() {
    const plan = yield* finalizePlan(input)
    const invalid = { ...plan, edits: [{ projectId: "app" }] }
    expect(Exit.isFailure(yield* Effect.exit(parsePlan(JSON.stringify(invalid))))).toBe(true)
  }))
})
