/** Canonical, serializable Transformation Plan envelope. */
import { createHash } from "node:crypto"
import { Data, Effect } from "effect"

export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

export interface ProjectEvidence {
  readonly id: string
  readonly configFileName: string
}

export interface SourceFingerprint {
  readonly projectId: string
  readonly fileName: string
  readonly hash: string
}

export interface PlannedTextEdit {
  readonly projectId: string
  readonly fileName: string
  readonly start: number
  readonly end: number
  readonly expectedTextHash: string
  readonly newText: string
  readonly evidenceIds: ReadonlyArray<string>
}

export interface PlannedFileOperation {
  readonly kind: "create" | "delete" | "move"
  readonly projectId: string
  readonly path: string
  readonly toPath?: string
  readonly content?: string
  readonly initialHash?: string
  readonly evidenceIds?: ReadonlyArray<string>
}

export interface EvidenceRecord {
  readonly id: string
  readonly kind: string
  readonly facts: { readonly [key: string]: Json }
}

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
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]))
  }
  return value
}

export const canonicalJson = (value: Json): string => JSON.stringify(canonicalize(value))

// SAFETY: value is guaranteed to be JSON serializable
const asJson = (value: Json | TransformationPlan | { readonly projects: ReadonlyArray<ProjectEvidence>; readonly sources: ReadonlyArray<SourceFingerprint> }): Json => value as Json

const editCompare = (left: PlannedTextEdit, right: PlannedTextEdit): number =>
  left.projectId.localeCompare(right.projectId) ||
  left.fileName.localeCompare(right.fileName) ||
  left.start - right.start ||
  left.end - right.end ||
  left.newText.localeCompare(right.newText)

const editConflict = (left: PlannedTextEdit, right: PlannedTextEdit): boolean => {
  if (left.projectId !== right.projectId || left.fileName !== right.fileName) return false
  const leftInsert = left.start === left.end
  const rightInsert = right.start === right.end
  if (leftInsert && rightInsert) return left.start === right.start
  if (leftInsert) return left.start >= right.start && left.start <= right.end
  if (rightInsert) return right.start >= left.start && right.start <= left.end
  return left.start < right.end && right.start < left.end
}

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
  })).sort(editCompare)
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
    if (previous !== undefined && editConflict(previous, edit)) {
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

export const parsePlan = (text: string): Effect.Effect<TransformationPlan, PlanDecodeError> =>
  Effect.try({
    // SAFETY: JSON parsing returns unknown payload
    try: () => JSON.parse(text) as unknown,
    catch: () => new PlanDecodeError({ reason: "json" }),
  }).pipe(Effect.flatMap((decoded) => Effect.gen(function*() {
    if (
      decoded === null || typeof decoded !== "object" ||
      !("schemaVersion" in decoded) || decoded.schemaVersion !== 1 ||
      !("planId" in decoded) || typeof decoded.planId !== "string"
    ) return yield* new PlanDecodeError({ reason: "schema" })
    // SAFETY: validated schemaVersion and planId fields
    const plan = decoded as TransformationPlan
    if (digest(canonicalJson(withoutId(plan))) !== plan.planId) {
      return yield* new PlanDecodeError({ reason: "hash" })
    }
    return plan
  })))

