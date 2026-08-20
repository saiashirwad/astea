import { describe, effect, expect } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { asJson, finalizePlan, parsePlan, serializePlan, validatePlan } from "./index.ts"
import {
  digest,
  encodeUnknown,
  exactStructureMutations,
  finalizeUnknown,
  nonJsonMutations,
  rehashPlan,
  richInput,
  semanticMutations,
  validateUnknown,
} from "../test/plan-schema.ts"

describe("plan structural and semantic validation", () => {
  effect("uses one exact structural contract at finalize, validate, and parse boundaries", () =>
    Effect.gen(function* () {
      const plan = yield* finalizePlan(richInput)
      for (const mutation of exactStructureMutations) {
        const finalized = yield* finalizeUnknown(mutation.mutate(richInput)).pipe(Effect.result)
        const mutatedPlan = mutation.mutate(plan)
        const validated = yield* validateUnknown(mutatedPlan).pipe(Effect.result)
        const parsed = yield* parsePlan(encodeUnknown(mutatedPlan)).pipe(Effect.result)

        expect({ name: mutation.name, outcome: finalized._tag }).toEqual({
          name: mutation.name,
          outcome: "Failure",
        })
        expect({ name: mutation.name, outcome: validated._tag }).toEqual({
          name: mutation.name,
          outcome: "Failure",
        })
        expect({ name: mutation.name, outcome: parsed._tag }).toEqual({
          name: mutation.name,
          outcome: "Failure",
        })
        if (validated._tag === "Failure") expect(validated.failure.reason).toBe("schema")
        if (parsed._tag === "Failure") expect(parsed.failure.reason).toBe("schema")
      }
    }),
  )

  effect("rejects non-JSON options and evidence at in-memory boundaries", () =>
    Effect.gen(function* () {
      const plan = yield* finalizePlan(richInput)
      for (const mutation of nonJsonMutations) {
        const finalized = yield* finalizeUnknown(mutation.mutate(richInput)).pipe(Effect.result)
        const validated = yield* validateUnknown(mutation.mutate(plan)).pipe(Effect.result)
        expect({ name: mutation.name, outcome: finalized._tag }).toEqual({
          name: mutation.name,
          outcome: "Failure",
        })
        expect({ name: mutation.name, outcome: validated._tag }).toEqual({
          name: mutation.name,
          outcome: "Failure",
        })
        if (validated._tag === "Failure") expect(validated.failure.reason).toBe("schema")
      }
    }),
  )

  effect("rejects semantic input mutations", () =>
    Effect.gen(function* () {
      for (const mutation of semanticMutations) {
        const result = yield* Effect.exit(finalizeUnknown(mutation.mutate(richInput)))
        expect({ name: mutation.name, rejected: Exit.isFailure(result) }).toEqual({
          name: mutation.name,
          rejected: true,
        })
      }
    }),
  )

  effect("rejects non-canonical array ordering even when hashes are recomputed", () =>
    Effect.gen(function* () {
      const plan = yield* finalizePlan(richInput)
      const sources = [...plan.sources].reverse()
      const unorderedPlans = [
        rehashPlan({ ...plan, evidence: [...plan.evidence].reverse() }),
        rehashPlan({ ...plan, fileOperations: [...plan.fileOperations!].reverse() }),
        rehashPlan({
          ...plan,
          sources,
          snapshotHash: digest(asJson({ projects: plan.projects, sources })),
        }),
      ]

      for (const unordered of unorderedPlans) {
        const validated = yield* validatePlan(unordered).pipe(Effect.result)
        const parsed = yield* parsePlan(serializePlan(unordered)).pipe(Effect.result)
        expect(validated._tag).toBe("Failure")
        expect(parsed._tag).toBe("Failure")
        if (validated._tag === "Failure") expect(validated.failure.reason).toBe("schema")
        if (parsed._tag === "Failure") expect(parsed.failure.reason).toBe("schema")
      }
    }),
  )
})
