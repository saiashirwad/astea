import { describe, effect, expect } from "@effect/vitest"
import { Effect, Exit } from "effect"
import {
  asJson,
  canonicalJson,
  finalizePlan,
  parsePlan,
  serializePlan,
  type PlanInput,
} from "./index.ts"
import { createHash } from "node:crypto"
import { parseProjectRelativePath } from "../Workspace/ProjectPath.ts"

interface MalformedPlanInput extends Omit<PlanInput, "projects"> {
  readonly projects: ReadonlyArray<unknown>
}

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
  effect("round-trips canonical plans with stable hashes", () =>
    Effect.gen(function* () {
      const first = yield* finalizePlan(input)
      const second = yield* finalizePlan(input)
      expect(first.planId).toBe(second.planId)
      expect(yield* parsePlan(serializePlan(first))).toEqual(first)
    }),
  )

  effect("rejects structurally invalid plan payloads", () =>
    Effect.gen(function* () {
      const plan = yield* finalizePlan(input)
      const invalid = { ...plan, edits: [{ projectId: "app" }] }
      expect(Exit.isFailure(yield* Effect.exit(parsePlan(JSON.stringify(invalid))))).toBe(true)
    }),
  )

  effect("rejects malformed finalize input without throwing", () =>
    Effect.gen(function* () {
      const malformed: MalformedPlanInput = { ...input, projects: [null] }
      // SAFETY: the test deliberately injects an invalid project at the input boundary.
      const failure = yield* Effect.exit(finalizePlan(malformed as PlanInput))
      expect(Exit.isFailure(failure)).toBe(true)
    }),
  )

  effect("rejects unsafe project-relative paths", () =>
    Effect.sync(() => {
      for (const path of [
        "../escape.ts",
        "/tmp/file.ts",
        "C:\\tmp\\file.ts",
        "C:/tmp/file.ts",
        "\\\\server\\share\\file.ts",
        "//server/share/file.ts",
        "bad\0name.ts",
      ]) {
        expect(parseProjectRelativePath(path)).toBeUndefined()
      }
      expect(parseProjectRelativePath("src/../src/index.ts")).toBe("src/index.ts")
    }),
  )

  effect("rejects a semantically invalid plan even when rehashed", () =>
    Effect.gen(function* () {
      const plan = yield* finalizePlan(input)
      const malformed = {
        ...plan,
        edits: [
          {
            projectId: "unknown",
            fileName: "src/index.ts",
            start: -1,
            end: 0,
            expectedTextHash: "",
            newText: "x",
            evidenceIds: [],
          },
        ],
      }
      const withoutId = ({ planId: _, ...rest }: typeof malformed) => rest
      const encoded = canonicalJson(
        asJson({
          ...malformed,
          planId: createHash("sha256")
            .update(canonicalJson(asJson(withoutId(malformed))))
            .digest("hex"),
        }),
      )
      expect(Exit.isFailure(yield* Effect.exit(parsePlan(encoded)))).toBe(true)
    }),
  )
})
