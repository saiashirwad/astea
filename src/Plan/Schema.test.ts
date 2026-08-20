import { createHash } from "node:crypto"
import { describe, effect, expect } from "@effect/vitest"
import { Effect, Exit } from "effect"
import {
  asJson,
  canonicalJson,
  finalizePlan,
  parsePlan,
  requireProjectRelativePath,
  serializePlan,
  validatePlan,
  type Json,
  type PlanInput,
  type TransformationPlan,
} from "./index.ts"
import { canonicalJson as canonicalEvidenceJson } from "../Evidence/Canonical.ts"
import { parseProjectRelativePath } from "../ProjectPath/index.ts"

const richInput = {
  recipe: {
    name: "test",
    version: "1",
    implementationHash: "impl",
    options: { enabled: true, nested: [null, 1, "x"] },
  },
  toolchain: { systemVersion: "1", typescriptVersion: "7", effectVersion: "4" },
  projects: [{ id: "app", configFileName: "tsconfig.json" }],
  sources: [
    { projectId: "app", fileName: "src/index.ts", hash: "source" },
    { projectId: "app", fileName: "src/delete.ts", hash: "delete" },
    { projectId: "app", fileName: "src/move.ts", hash: "move" },
  ],
  edits: [
    {
      projectId: "app",
      fileName: "src/index.ts",
      start: 0,
      end: 0,
      expectedTextHash: "empty",
      newText: "x",
      evidenceIds: ["edit"],
    },
  ],
  fileOperations: [
    {
      kind: "create",
      projectId: "app",
      path: requireProjectRelativePath("src/created.ts"),
      content: "created",
      evidenceIds: ["create"],
    },
    {
      kind: "delete",
      projectId: "app",
      path: requireProjectRelativePath("src/delete.ts"),
      initialHash: "delete",
      evidenceIds: ["delete"],
    },
    {
      kind: "move",
      projectId: "app",
      path: requireProjectRelativePath("src/move.ts"),
      toPath: requireProjectRelativePath("src/moved.ts"),
      initialHash: "move",
      content: "moved",
      evidenceIds: ["move"],
    },
  ],
  evidence: [
    { id: "edit", kind: "selection", facts: { nested: { valid: true } } },
    { id: "create", kind: "operation", facts: {} },
    { id: "delete", kind: "operation", facts: {} },
    { id: "move", kind: "operation", facts: {} },
  ],
  policies: {
    matchCount: { min: 1, max: 3 },
    maxAffectedFiles: 4,
    diagnostics: "no-new-errors",
    idempotence: "required",
  },
  measurements: { matches: 1 },
} satisfies PlanInput

interface InputMutation {
  readonly name: string
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- mutation table produces invalid payloads on purpose.
  readonly mutate: (input: PlanInput) => unknown
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- invalid file-operation payloads.
const withOperation = (input: PlanInput, index: number, operation: unknown): unknown => ({
  ...input,
  fileOperations: input.fileOperations?.map((current, currentIndex) =>
    currentIndex === index ? operation : current,
  ),
})

const exactStructureMutations: ReadonlyArray<InputMutation> = [
  { name: "unknown plan input field", mutate: (value) => ({ ...value, unexpected: true }) },
  {
    name: "unknown recipe field",
    mutate: (value) => ({ ...value, recipe: { ...value.recipe, unexpected: true } }),
  },
  {
    name: "unknown project field",
    mutate: (value) => ({
      ...value,
      projects: [{ ...value.projects[0]!, unexpected: true }],
    }),
  },
  {
    name: "unknown source field",
    mutate: (value) => ({
      ...value,
      sources: value.sources.map((source, index) =>
        index === 0 ? { ...source, unexpected: true } : source,
      ),
    }),
  },
  {
    name: "unknown edit field",
    mutate: (value) => ({
      ...value,
      edits: [{ ...value.edits[0]!, unexpected: true }],
    }),
  },
  {
    name: "unknown evidence field",
    mutate: (value) => ({
      ...value,
      evidence: value.evidence.map((item, index) =>
        index === 0 ? { ...item, unexpected: true } : item,
      ),
    }),
  },
  {
    name: "unknown policy field",
    mutate: (value) => ({ ...value, policies: { ...value.policies, unexpected: true } }),
  },
  {
    name: "unknown measurement field",
    mutate: (value) => ({
      ...value,
      measurements: { ...value.measurements, unexpected: true },
    }),
  },
  {
    name: "unknown create field",
    mutate: (value) =>
      withOperation(value, 0, { ...value.fileOperations![0]!, initialHash: "unexpected" }),
  },
  {
    name: "unknown delete field",
    mutate: (value) =>
      withOperation(value, 1, { ...value.fileOperations![1]!, content: "unexpected" }),
  },
  {
    name: "unknown move field",
    mutate: (value) =>
      withOperation(value, 2, { ...value.fileOperations![2]!, destination: "unexpected" }),
  },
  {
    name: "missing recipe",
    mutate: ({ recipe: _, ...value }) => value,
  },
  {
    name: "missing project id",
    mutate: (value) => ({ ...value, projects: [{ configFileName: "tsconfig.json" }] }),
  },
  {
    name: "missing create content",
    mutate: (value) =>
      withOperation(value, 0, {
        kind: "create",
        projectId: "app",
        path: "src/created.ts",
        evidenceIds: ["create"],
      }),
  },
  {
    name: "missing delete initial hash",
    mutate: (value) =>
      withOperation(value, 1, {
        kind: "delete",
        projectId: "app",
        path: "src/delete.ts",
        evidenceIds: ["delete"],
      }),
  },
  {
    name: "missing move target",
    mutate: (value) =>
      withOperation(value, 2, {
        kind: "move",
        projectId: "app",
        path: "src/move.ts",
        initialHash: "move",
        evidenceIds: ["move"],
      }),
  },
  {
    name: "missing evidence facts",
    mutate: (value) => ({
      ...value,
      evidence: [{ id: "edit", kind: "selection" }, ...value.evidence.slice(1)],
    }),
  },
]

const nonJsonMutations: ReadonlyArray<InputMutation> = [
  {
    name: "non-JSON recipe options",
    mutate: (value) => ({ ...value, recipe: { ...value.recipe, options: () => "invalid" } }),
  },
  {
    name: "non-JSON evidence facts",
    mutate: (value) => ({
      ...value,
      evidence: [
        { ...value.evidence[0]!, facts: { value: undefined } },
        ...value.evidence.slice(1),
      ],
    }),
  },
]

const semanticMutations: ReadonlyArray<InputMutation> = [
  {
    name: "unsafe project path",
    mutate: (value) => ({
      ...value,
      projects: [{ ...value.projects[0]!, configFileName: "../tsconfig.json" }],
    }),
  },
  {
    name: "unsafe source path",
    mutate: (value) => ({
      ...value,
      sources: [{ ...value.sources[0]!, fileName: "/src/index.ts" }, ...value.sources.slice(1)],
    }),
  },
  {
    name: "unsafe edit path",
    mutate: (value) => ({ ...value, edits: [{ ...value.edits[0]!, fileName: "../index.ts" }] }),
  },
  {
    name: "unsafe create path",
    mutate: (value) => withOperation(value, 0, { ...value.fileOperations![0]!, path: "../x" }),
  },
  {
    name: "unsafe delete path",
    mutate: (value) => withOperation(value, 1, { ...value.fileOperations![1]!, path: "/x" }),
  },
  {
    name: "unsafe move source path",
    mutate: (value) => withOperation(value, 2, { ...value.fileOperations![2]!, path: "C:/x" }),
  },
  {
    name: "unsafe move target path",
    mutate: (value) => withOperation(value, 2, { ...value.fileOperations![2]!, toPath: "../x" }),
  },
  {
    name: "duplicate project identity",
    mutate: (value) => ({ ...value, projects: [...value.projects, value.projects[0]!] }),
  },
  {
    name: "duplicate source identity",
    mutate: (value) => ({ ...value, sources: [...value.sources, value.sources[0]!] }),
  },
  {
    name: "duplicate evidence identity",
    mutate: (value) => ({ ...value, evidence: [...value.evidence, value.evidence[0]!] }),
  },
  {
    name: "negative policy minimum",
    mutate: (value) => ({
      ...value,
      policies: { ...value.policies, matchCount: { ...value.policies.matchCount, min: -1 } },
    }),
  },
  {
    name: "fractional policy maximum",
    mutate: (value) => ({
      ...value,
      policies: { ...value.policies, matchCount: { ...value.policies.matchCount, max: 1.5 } },
    }),
  },
  {
    name: "inverted policy range",
    mutate: (value) => ({
      ...value,
      policies: { ...value.policies, matchCount: { min: 4, max: 3 } },
    }),
  },
  {
    name: "non-finite affected-file limit",
    mutate: (value) => ({ ...value, policies: { ...value.policies, maxAffectedFiles: Infinity } }),
  },
  {
    name: "non-finite measurement",
    mutate: (value) => ({ ...value, measurements: { matches: Number.NaN } }),
  },
  {
    name: "missing edit evidence link",
    mutate: (value) => ({
      ...value,
      edits: [{ ...value.edits[0]!, evidenceIds: ["unknown"] }],
    }),
  },
  {
    name: "missing create evidence link",
    mutate: (value) =>
      withOperation(value, 0, { ...value.fileOperations![0]!, evidenceIds: ["unknown"] }),
  },
  {
    name: "missing delete evidence link",
    mutate: (value) =>
      withOperation(value, 1, { ...value.fileOperations![1]!, evidenceIds: ["unknown"] }),
  },
  {
    name: "missing move evidence link",
    mutate: (value) =>
      withOperation(value, 2, { ...value.fileOperations![2]!, evidenceIds: ["unknown"] }),
  },
]

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- mutation cases are invalid payloads.
const finalizeUnknown = (candidate: unknown) =>
  // SAFETY: mutation tests deliberately send untyped values through the public boundary.
  finalizePlan(candidate as PlanInput)

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- mutation cases are invalid payloads.
const validateUnknown = (candidate: unknown) =>
  // SAFETY: mutation tests deliberately send untyped values through the public boundary.
  validatePlan(candidate as TransformationPlan)

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- exact-structure mutations remain JSON values.
const encodeUnknown = (candidate: unknown): string =>
  // SAFETY: exact-structure mutations in this test remain JSON values.
  canonicalJson(candidate as Json)

const digest = (value: Json): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex")

const rehashPlan = (plan: TransformationPlan): TransformationPlan => {
  const { planId: _, ...payload } = plan
  return { ...plan, planId: digest(asJson(payload)) }
}

describe("Plan schema", () => {
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

  effect("rejects unsafe project-relative path spellings", () =>
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
})
