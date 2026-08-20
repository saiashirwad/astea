import { createHash } from "node:crypto"
import {
  asJson,
  canonicalJson,
  finalizePlan,
  requireProjectRelativePath,
  validatePlan,
  type Json,
  type PlanInput,
  type TransformationPlan,
} from "../Plan/index.ts"

export const richInput = {
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

export const exactStructureMutations: ReadonlyArray<InputMutation> = [
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

export const nonJsonMutations: ReadonlyArray<InputMutation> = [
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

export const semanticMutations: ReadonlyArray<InputMutation> = [
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
export const finalizeUnknown = (candidate: unknown) =>
  // SAFETY: mutation tests deliberately send untyped values through the public boundary.
  finalizePlan(candidate as PlanInput)

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- mutation cases are invalid payloads.
export const validateUnknown = (candidate: unknown) =>
  // SAFETY: mutation tests deliberately send untyped values through the public boundary.
  validatePlan(candidate as TransformationPlan)

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- exact-structure mutations remain JSON values.
export const encodeUnknown = (candidate: unknown): string =>
  // SAFETY: exact-structure mutations in this test remain JSON values.
  canonicalJson(candidate as Json)

export const digest = (value: Json): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex")

export const rehashPlan = (plan: TransformationPlan): TransformationPlan => {
  const { planId: _, ...payload } = plan
  return { ...plan, planId: digest(asJson(payload)) }
}
