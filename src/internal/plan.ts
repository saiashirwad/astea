/** Canonical, serializable Transformation Plan envelope. */
import { createHash } from "node:crypto"
import { Data, Effect, Predicate, Schema } from "effect"
import type { EvidenceRecord, Json } from "../Evidence/Model.ts"
import { compareEdits, editsConflict, type TextEdit } from "../Edit/index.ts"

export type { Json } from "../Evidence/Model.ts"

export interface ProjectEvidence {
  readonly id: string
  readonly configFileName: string
}

export interface SourceFingerprint {
  readonly projectId: string
  readonly fileName: string
  readonly hash: string
}

/** @deprecated Use the canonical Edit.TextEdit type. */
export type PlannedTextEdit = TextEdit

export interface PlannedFileOperation {
  readonly kind: "create" | "delete" | "move"
  readonly projectId: string
  readonly path: string
  readonly toPath?: string
  readonly content?: string
  readonly initialHash?: string
  readonly evidenceIds?: ReadonlyArray<string>
}

export type { EvidenceRecord } from "../Evidence/Model.ts"

export interface PlanPolicies {
  readonly matchCount: { readonly min?: number; readonly max?: number }
  readonly maxAffectedFiles?: number
  readonly diagnostics: "no-new-errors" | "exact-delta"
  readonly idempotence: "required" | "not-promised"
}

export interface PlanMeasurements {
  readonly matches?: number
}

export interface TransformationPlan {
  readonly schemaVersion: 1
  readonly planId: string
  readonly recipe: {
    readonly name: string
    readonly version: string
    readonly implementationHash: string
    readonly options: Json
  }
  readonly toolchain: {
    readonly systemVersion: string
    readonly typescriptVersion: string
    readonly effectVersion: string
  }
  readonly projects: ReadonlyArray<ProjectEvidence>
  readonly sources: ReadonlyArray<SourceFingerprint>
  readonly snapshotHash: string
  readonly edits: ReadonlyArray<PlannedTextEdit>
  readonly fileOperations?: ReadonlyArray<PlannedFileOperation>
  readonly evidence: ReadonlyArray<EvidenceRecord>
  readonly policies: PlanPolicies
  readonly measurements?: PlanMeasurements
}

export type PlanInput = Omit<TransformationPlan, "schemaVersion" | "planId" | "snapshotHash">

export class PlanBuildError extends Data.TaggedError("PlanBuildError")<{
  readonly reason: "invalid-edit" | "edit-conflict" | "missing-source" | "duplicate-evidence"
  readonly detail: string
}> {}

export class PlanDecodeError extends Data.TaggedError("PlanDecodeError")<{
  readonly reason: "json" | "schema" | "hash"
}> {}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex")

const canonicalize = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (Predicate.isObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]))
  }
  return value
}

export const canonicalJson = (value: Json): string => JSON.stringify(canonicalize(value))

// SAFETY: value is guaranteed to be JSON serializable
const asJson = (value: Json | TransformationPlan | { readonly projects: ReadonlyArray<ProjectEvidence>; readonly sources: ReadonlyArray<SourceFingerprint> }): Json => value as Json

const withoutId = (plan: TransformationPlan): Json => {
  const { planId: _, ...payload } = plan
  return asJson(payload)
}

export const finalizePlan = (
  input: PlanInput,
): Effect.Effect<TransformationPlan, PlanBuildError> => Effect.gen(function*() {
  const projects = [...input.projects].sort((left, right) => left.id.localeCompare(right.id))
  const sources = [...input.sources].sort((left, right) =>
    left.projectId.localeCompare(right.projectId) || left.fileName.localeCompare(right.fileName))
  const edits = [...input.edits].map((edit) => ({
    ...edit,
    evidenceIds: [...edit.evidenceIds].sort(),
  })).sort(compareEdits)
  const evidence = [...input.evidence].sort((left, right) => left.id.localeCompare(right.id))

  if (new Set(evidence.map((item) => item.id)).size !== evidence.length) {
    return yield* new PlanBuildError({ reason: "duplicate-evidence", detail: "Evidence IDs must be unique" })
  }
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index]!
    if (edit.start < 0 || edit.end < edit.start) {
      return yield* new PlanBuildError({ reason: "invalid-edit", detail: `${edit.fileName}:${edit.start}` })
    }
    if (!sources.some((source) => source.projectId === edit.projectId && source.fileName === edit.fileName)) {
      return yield* new PlanBuildError({ reason: "missing-source", detail: edit.fileName })
    }
    const previous = edits[index - 1]
    if (previous !== undefined && editsConflict(previous, edit)) {
      return yield* new PlanBuildError({ reason: "edit-conflict", detail: edit.fileName })
    }
  }

  const snapshotHash = digest(canonicalJson(asJson({ projects, sources })))
  const fileOperations = input.fileOperations === undefined
    ? undefined
    : [...input.fileOperations].sort((left, right) =>
        left.projectId.localeCompare(right.projectId) ||
        left.path.localeCompare(right.path) ||
        left.kind.localeCompare(right.kind)
      )
  const provisional: TransformationPlan = {
    schemaVersion: 1,
    planId: "",
    ...input,
    projects,
    sources,
    snapshotHash,
    edits,
    evidence,
  }
  const finalizedBase = fileOperations !== undefined ? { ...provisional, fileOperations } : provisional
  return { ...finalizedBase, planId: digest(canonicalJson(withoutId(finalizedBase))) }
})

export const serializePlan = (plan: TransformationPlan): string => canonicalJson(asJson(plan))

const TextEditSchema = Schema.Struct({
  projectId: Schema.String,
  fileName: Schema.String,
  start: Schema.Number,
  end: Schema.Number,
  expectedTextHash: Schema.String,
  newText: Schema.String,
  evidenceIds: Schema.Array(Schema.String),
})

const FileOperationSchema = Schema.Struct({
  kind: Schema.Union([Schema.Literal("create"), Schema.Literal("delete"), Schema.Literal("move")]),
  projectId: Schema.String,
  path: Schema.String,
  toPath: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  initialHash: Schema.optional(Schema.String),
  evidenceIds: Schema.optional(Schema.Array(Schema.String)),
})

/** Complete durable-plan decoder. No unchecked payload crosses this boundary. */
export const TransformationPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  planId: Schema.String,
  recipe: Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    implementationHash: Schema.String,
    options: Schema.Json,
  }),
  toolchain: Schema.Struct({
    systemVersion: Schema.String,
    typescriptVersion: Schema.String,
    effectVersion: Schema.String,
  }),
  projects: Schema.Array(Schema.Struct({ id: Schema.String, configFileName: Schema.String })),
  sources: Schema.Array(Schema.Struct({
    projectId: Schema.String,
    fileName: Schema.String,
    hash: Schema.String,
  })),
  snapshotHash: Schema.String,
  edits: Schema.Array(TextEditSchema),
  fileOperations: Schema.optional(Schema.Array(FileOperationSchema)),
  evidence: Schema.Array(Schema.Struct({
    id: Schema.String,
    kind: Schema.String,
    facts: Schema.Record(Schema.String, Schema.Json),
  })),
  policies: Schema.Struct({
    matchCount: Schema.Struct({
      min: Schema.optional(Schema.Number),
      max: Schema.optional(Schema.Number),
    }),
    maxAffectedFiles: Schema.optional(Schema.Number),
    diagnostics: Schema.Union([Schema.Literal("no-new-errors"), Schema.Literal("exact-delta")]),
    idempotence: Schema.Union([Schema.Literal("required"), Schema.Literal("not-promised")]),
  }),
  measurements: Schema.optional(Schema.Struct({ matches: Schema.optional(Schema.Number) })),
})

export const parsePlan = (text: string): Effect.Effect<TransformationPlan, PlanDecodeError> =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => new PlanDecodeError({ reason: "json" })),
    Effect.flatMap((decoded) =>
      Schema.decodeUnknownEffect(TransformationPlanSchema)(decoded).pipe(
        Effect.mapError(() => new PlanDecodeError({ reason: "schema" })),
      )
    ),
    Effect.flatMap((decoded) => Effect.gen(function*() {
      const plan: TransformationPlan = decoded
      if (digest(canonicalJson(withoutId(plan))) !== plan.planId) {
        return yield* new PlanDecodeError({ reason: "hash" })
      }
      return plan
    })),
  )
