import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import type { Json } from "../Evidence/index.ts"
import { canonicalJson, finalizePlan, parsePlan, serializePlan, type PlanInput } from "./index.ts"
import { canonicalJson as canonicalEvidenceJson } from "../Evidence/Canonical.ts"
import { richInput } from "../test/plan-schema.ts"

describe("plan codec and canonicalization", () => {
  effect("uses the evidence canonical JSON operation for durable plan values", () =>
    Effect.sync(() => {
      const value: Json = {
        outer: { zebra: [3, { beta: false, alpha: true }], alpha: null },
        alpha: "first",
      }

      expect(canonicalJson(value)).toBe(
        '{"alpha":"first","outer":{"alpha":null,"zebra":[3,{"alpha":true,"beta":false}]}}',
      )
      expect(canonicalJson(value)).toBe(canonicalEvidenceJson(value))
    }),
  )

  effect("round-trips the schema-version 1 canonical fixture without changing IDs", () =>
    Effect.gen(function* () {
      const plan = yield* finalizePlan(richInput)
      const serialized = serializePlan(plan)
      const parsed = yield* parsePlan(serialized)

      expect(plan.schemaVersion).toBe(1)
      expect(plan.planId).toBe("4c21f75c1188213ff7a7630678ea6b697789db924d4e4ddc0c987f13279cb768")
      expect(plan.snapshotHash).toBe(
        "b94070e67eb09e018c5bf1263bd3941d9f221d5d6d0afecf9fe39c0ea218d7d1",
      )
      expect(parsed.planId).toBe(plan.planId)
      expect(parsed.snapshotHash).toBe(plan.snapshotHash)
      expect(serializePlan(parsed)).toBe(serialized)
      expect(parsed).toEqual(plan)

      const helperStyleInput: PlanInput = {
        ...richInput,
        edits: [
          {
            ...richInput.edits[0]!,
            evidenceIds: ["node:replace:app:src/index.ts:0-0", "selection:app:src/index.ts:0-1"],
          },
        ],
        evidence: [
          {
            id: "node:replace:app:src/index.ts:0-0",
            kind: "draft-operation",
            facts: { operation: "node:replace", source: "concat" },
          },
          {
            id: "selection:app:src/index.ts:0-1",
            kind: "selection",
            facts: { projectId: "app", fileName: "src/index.ts", start: 0, end: 1 },
          },
          ...richInput.evidence.filter((record) => record.id !== "edit"),
        ],
      }
      const helperPlan = yield* finalizePlan(helperStyleInput)
      const helperAgain = yield* finalizePlan(helperStyleInput)
      expect(helperPlan.planId).toBe(helperAgain.planId)
      expect((yield* parsePlan(serializePlan(helperPlan))).planId).toBe(helperPlan.planId)

      const windowsStylePaths: PlanInput = {
        ...richInput,
        sources: richInput.sources.map((source) => ({
          ...source,
          fileName: source.fileName.replaceAll("/", "\\"),
        })),
        edits: richInput.edits.map((edit) => ({
          ...edit,
          fileName: edit.fileName.replaceAll("/", "\\"),
        })),
      }
      const portablePlan = yield* finalizePlan(richInput)
      const windowsStylePlan = yield* finalizePlan(windowsStylePaths)
      expect(windowsStylePlan.planId).toBe(portablePlan.planId)
      expect(windowsStylePlan.snapshotHash).toBe(portablePlan.snapshotHash)
    }),
  )
})
