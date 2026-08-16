/** Plan domain — canonical, serializable transformation plans. */
import { createHash } from "node:crypto"
import { Data, Effect, Predicate, Schema } from "effect"
import type { EvidenceRecord, Json } from "../Evidence/Model.ts"
import { compareEdits, editsConflict, type TextEdit } from "../Edit/index.ts"
import { parseProjectRelativePath, type ProjectRelativePath } from "../Workspace/ProjectPath.ts"

export type { Json } from "../Evidence/Model.ts"
export type { TextEdit } from "../Edit/index.ts"

export interface ProjectEvidence {
  readonly id: string
  readonly configFileName: string
}

export interface SourceFingerprint {
  readonly projectId: string
  readonly fileName: string
  readonly hash: string
}

interface FileOperationBase {
  readonly projectId: string
  readonly path: ProjectRelativePath
  readonly evidenceIds?: ReadonlyArray<string> | undefined
}

export interface CreateFileOperation extends FileOperationBase {
  readonly kind: "create"
  readonly content: string
}

export interface DeleteFileOperation extends FileOperationBase {
  readonly kind: "delete"
  readonly initialHash: string
}

export interface MoveFileOperation extends FileOperationBase {
  readonly kind: "move"
  readonly toPath: ProjectRelativePath
  readonly initialHash: string
  /** Optional content lets callers make the move self-contained. */
  readonly content?: string | undefined
}

export type PlannedFileOperation = CreateFileOperation | DeleteFileOperation | MoveFileOperation

export type { EvidenceRecord } from "../Evidence/Model.ts"

export interface PlanPolicies {
  readonly matchCount: { readonly min?: number | undefined; readonly max?: number | undefined }
  readonly maxAffectedFiles?: number | undefined
  readonly diagnostics: "no-new-errors" | "exact-delta"
  readonly idempotence: "required" | "not-promised"
}

export interface PlanMeasurements {
  readonly matches?: number | undefined
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
  readonly edits: ReadonlyArray<TextEdit>
  readonly fileOperations?: ReadonlyArray<PlannedFileOperation> | undefined
  readonly evidence: ReadonlyArray<EvidenceRecord>
  readonly policies: PlanPolicies
  readonly measurements?: PlanMeasurements | undefined
}

export type PlanInput = Omit<TransformationPlan, "schemaVersion" | "planId" | "snapshotHash">

export class PlanBuildError extends Data.TaggedError("PlanBuildError")<{
  readonly reason:
    | "invalid-edit"
    | "edit-conflict"
    | "missing-source"
    | "duplicate-evidence"
    | "invalid-path"
    | "invalid-file-operation"
    | "duplicate-project"
    | "duplicate-source"
    | "missing-evidence"
    | "invalid-policy"
    | "invalid-plan"
  readonly detail: string
}> {}

export class PlanDecodeError extends Data.TaggedError("PlanDecodeError")<{
  readonly reason: "json" | "schema" | "hash"
}> {}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex")

const canonicalize = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

export const canonicalJson = (value: Json): string => JSON.stringify(canonicalize(value))

// SAFETY: value is guaranteed to be JSON serializable
const asJson = (
  value:
    | Json
    | TransformationPlan
    | {
        readonly projects: ReadonlyArray<ProjectEvidence>
        readonly sources: ReadonlyArray<SourceFingerprint>
      },
): Json => value as Json

const withoutId = (plan: TransformationPlan): Json => {
  const { planId: _, ...payload } = plan
  return asJson(payload)
}

const fail = (
  reason: PlanBuildError["reason"],
  detail: string,
): Effect.Effect<never, PlanBuildError> => Effect.fail(new PlanBuildError({ reason, detail }))

const isFiniteNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0

const normalizedPath = (value: string): ProjectRelativePath | undefined =>
  parseProjectRelativePath(value)

const operationKeys = (operation: PlannedFileOperation): Array<string> => {
  const keys = [`${operation.projectId}\0${operation.path}`]
  if (operation.kind === "move") keys.push(`${operation.projectId}\0${operation.toPath}`)
  return keys
}

const operationFields: Record<PlannedFileOperation["kind"], ReadonlySet<string>> = {
  create: new Set(["kind", "projectId", "path", "content", "evidenceIds"]),
  delete: new Set(["kind", "projectId", "path", "initialHash", "evidenceIds"]),
  move: new Set(["kind", "projectId", "path", "toPath", "initialHash", "content", "evidenceIds"]),
}

const requiredOperationFields: Record<PlannedFileOperation["kind"], ReadonlyArray<string>> = {
  create: ["kind", "projectId", "path", "content"],
  delete: ["kind", "projectId", "path", "initialHash"],
  move: ["kind", "projectId", "path", "toPath", "initialHash"],
}

const hasExactOperationFields = (operation: unknown): operation is PlannedFileOperation => {
  if (
    !Predicate.isObject(operation) ||
    (operation.kind !== "create" && operation.kind !== "delete" && operation.kind !== "move")
  )
    return false
  const kind = operation.kind
  return (
    Object.keys(operation).every((key) => operationFields[kind].has(key)) &&
    requiredOperationFields[kind].every((key) => key in operation)
  )
}

const validateOperation = (
  operation: PlannedFileOperation,
  projects: ReadonlySet<string>,
  sources: ReadonlyMap<string, SourceFingerprint>,
  evidence: ReadonlySet<string>,
): string | undefined => {
  if (!hasExactOperationFields(operation)) return "File operation fields do not match its kind"
  if (!projects.has(operation.projectId)) return `Unknown project ${operation.projectId}`
  if (normalizedPath(operation.path) === undefined) return `Invalid path ${operation.path}`
  for (const id of operation.evidenceIds ?? [])
    if (!evidence.has(id)) return `Unknown evidence ${id}`
  const source = sources.get(`${operation.projectId}\0${operation.path}`)
  if (operation.kind === "create") {
    if (operation.content === undefined) return "Create operation requires content"
    if (source !== undefined) return `Create path already exists: ${operation.path}`
  } else {
    if (source === undefined) return `Missing source ${operation.path}`
    if (operation.initialHash !== source.hash) return `Fingerprint mismatch ${operation.path}`
    if (operation.kind === "move") {
      if (normalizedPath(operation.toPath) === undefined)
        return `Invalid target path ${operation.toPath}`
      if (operation.toPath === operation.path) return "Move source and target must differ"
      if (sources.has(`${operation.projectId}\0${operation.toPath}`))
        return `Move target exists: ${operation.toPath}`
    }
  }
  return undefined
}

const validateInput = (input: PlanInput): Effect.Effect<void, PlanBuildError> =>
  Effect.gen(function* () {
    if (
      !Array.isArray(input.projects) ||
      !Array.isArray(input.sources) ||
      !Array.isArray(input.edits) ||
      !Array.isArray(input.evidence) ||
      (input.fileOperations !== undefined && !Array.isArray(input.fileOperations))
    ) {
      return yield* fail("invalid-plan", "Plan collections must be arrays")
    }
    const projectIds = new Set<string>()
    for (const project of input.projects) {
      if (typeof project.id !== "string" || project.id.length === 0 || projectIds.has(project.id)) {
        return yield* fail(
          projectIds.has(project.id) ? "duplicate-project" : "invalid-plan",
          `Invalid project ${project.id}`,
        )
      }
      if (normalizedPath(project.configFileName) === undefined) {
        return yield* fail("invalid-path", project.configFileName)
      }
      projectIds.add(project.id)
    }
    const sourceMap = new Map<string, SourceFingerprint>()
    for (const source of input.sources) {
      const path = normalizedPath(source.fileName)
      if (path === undefined) return yield* fail("invalid-path", source.fileName)
      if (!projectIds.has(source.projectId)) return yield* fail("missing-source", source.fileName)
      const key = `${source.projectId}\0${path}`
      if (sourceMap.has(key)) return yield* fail("duplicate-source", source.fileName)
      sourceMap.set(key, { ...source, fileName: path })
    }
    const evidenceIds = new Set<string>()
    for (const item of input.evidence) {
      if (typeof item.id !== "string" || item.id.length === 0 || evidenceIds.has(item.id)) {
        return yield* fail("duplicate-evidence", `Evidence IDs must be unique: ${item.id}`)
      }
      evidenceIds.add(item.id)
    }
    for (const edit of input.edits) {
      if (
        !isFiniteNonnegativeInteger(edit.start) ||
        !isFiniteNonnegativeInteger(edit.end) ||
        edit.end < edit.start
      ) {
        return yield* fail("invalid-edit", `${edit.fileName}:${edit.start}`)
      }
      const fileName = normalizedPath(edit.fileName)
      if (fileName === undefined) return yield* fail("invalid-path", edit.fileName)
      if (!projectIds.has(edit.projectId) || !sourceMap.has(`${edit.projectId}\0${fileName}`)) {
        return yield* fail("missing-source", edit.fileName)
      }
      for (const id of edit.evidenceIds)
        if (!evidenceIds.has(id)) return yield* fail("missing-evidence", id)
    }
    if (input.fileOperations !== undefined) {
      const occupied = new Set<string>()
      for (const operation of input.fileOperations) {
        const path = normalizedPath(operation.path)
        if (path === undefined) return yield* fail("invalid-path", operation.path)
        const normalized =
          operation.kind === "move" && normalizedPath(operation.toPath) !== undefined
            ? { ...operation, path, toPath: normalizedPath(operation.toPath)! }
            : { ...operation, path }
        const error = validateOperation(normalized, projectIds, sourceMap, evidenceIds)
        if (error !== undefined) return yield* fail("invalid-file-operation", error)
        for (const key of operationKeys(normalized)) {
          if (occupied.has(key))
            return yield* fail("invalid-file-operation", `Conflicting file operation ${key}`)
          occupied.add(key)
        }
      }
    }
    const { min, max } = input.policies.matchCount
    if (
      (min !== undefined && !isFiniteNonnegativeInteger(min)) ||
      (max !== undefined && !isFiniteNonnegativeInteger(max)) ||
      (min !== undefined && max !== undefined && min > max) ||
      (input.policies.maxAffectedFiles !== undefined &&
        !isFiniteNonnegativeInteger(input.policies.maxAffectedFiles)) ||
      (input.measurements?.matches !== undefined &&
        !isFiniteNonnegativeInteger(input.measurements.matches))
    ) {
      return yield* fail(
        "invalid-policy",
        "Policy counts must be finite nonnegative integers with min <= max",
      )
    }
  })

export const finalizePlan = (input: PlanInput): Effect.Effect<TransformationPlan, PlanBuildError> =>
  Effect.gen(function* () {
    yield* validateInput(input)
    const projects = [...input.projects]
      .map((project) => ({
        ...project,
        configFileName: normalizedPath(project.configFileName)!,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
    const sources = [...input.sources]
      .map((source) => ({
        ...source,
        fileName: normalizedPath(source.fileName)!,
      }))
      .sort(
        (left, right) =>
          left.projectId.localeCompare(right.projectId) ||
          left.fileName.localeCompare(right.fileName),
      )
    const edits = [...input.edits]
      .map((edit) => ({
        ...edit,
        fileName: normalizedPath(edit.fileName)!,
        evidenceIds: [...edit.evidenceIds].sort(),
      }))
      .sort(compareEdits)
    const evidence = [...input.evidence].sort((left, right) => left.id.localeCompare(right.id))

    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index]!
      const previous = edits[index - 1]
      if (previous !== undefined && editsConflict(previous, edit)) {
        return yield* new PlanBuildError({ reason: "edit-conflict", detail: edit.fileName })
      }
    }

    const fileOperations =
      input.fileOperations === undefined
        ? undefined
        : [...input.fileOperations]
            .map((operation) =>
              operation.kind === "move"
                ? {
                    ...operation,
                    path: normalizedPath(operation.path)!,
                    toPath: normalizedPath(operation.toPath)!,
                    evidenceIds:
                      operation.evidenceIds === undefined
                        ? undefined
                        : [...operation.evidenceIds].sort(),
                  }
                : {
                    ...operation,
                    path: normalizedPath(operation.path)!,
                    evidenceIds:
                      operation.evidenceIds === undefined
                        ? undefined
                        : [...operation.evidenceIds].sort(),
                  },
            )
            .sort(
              (left, right) =>
                left.projectId.localeCompare(right.projectId) ||
                left.path.localeCompare(right.path) ||
                left.kind.localeCompare(right.kind),
            )
    const normalizedProjects = projects
    const normalizedSources = sources
    const snapshotHash = digest(
      canonicalJson(asJson({ projects: normalizedProjects, sources: normalizedSources })),
    )
    const provisional: TransformationPlan = {
      schemaVersion: 1,
      planId: "",
      ...input,
      projects: normalizedProjects,
      sources: normalizedSources,
      snapshotHash,
      edits,
      evidence,
    }
    const finalizedBase =
      fileOperations !== undefined ? { ...provisional, fileOperations } : provisional
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

const CreateFileOperationSchema = Schema.Struct({
  kind: Schema.Literal("create"),
  projectId: Schema.String,
  path: Schema.String,
  content: Schema.String,
  evidenceIds: Schema.optional(Schema.Array(Schema.String)),
})

const DeleteFileOperationSchema = Schema.Struct({
  kind: Schema.Literal("delete"),
  projectId: Schema.String,
  path: Schema.String,
  initialHash: Schema.String,
  evidenceIds: Schema.optional(Schema.Array(Schema.String)),
})

const MoveFileOperationSchema = Schema.Struct({
  kind: Schema.Literal("move"),
  projectId: Schema.String,
  path: Schema.String,
  toPath: Schema.String,
  content: Schema.optional(Schema.String),
  initialHash: Schema.String,
  evidenceIds: Schema.optional(Schema.Array(Schema.String)),
})

const FileOperationSchema = Schema.Union([
  CreateFileOperationSchema,
  DeleteFileOperationSchema,
  MoveFileOperationSchema,
])

const hasExactFileOperationFields = (value: unknown): boolean => {
  if (!Predicate.isObject(value)) return false
  const operations = value.fileOperations
  if (operations === undefined) return true
  if (!Array.isArray(operations)) return false
  return operations.every(hasExactOperationFields)
}

const validateDecodedPlan = (plan: TransformationPlan): Effect.Effect<void, PlanBuildError> =>
  Effect.gen(function* () {
    const { schemaVersion: _, planId: __, snapshotHash: ___, ...input } = plan
    yield* validateInput(input)
    const expectedSnapshot = digest(
      canonicalJson(asJson({ projects: plan.projects, sources: plan.sources })),
    )
    if (expectedSnapshot !== plan.snapshotHash)
      return yield* fail("invalid-plan", "Snapshot hash mismatch")
    const projects = [...plan.projects].sort((left, right) => left.id.localeCompare(right.id))
    const sources = [...plan.sources].sort(
      (left, right) =>
        left.projectId.localeCompare(right.projectId) ||
        left.fileName.localeCompare(right.fileName),
    )
    const edits = [...plan.edits].sort(compareEdits)
    const evidence = [...plan.evidence].sort((left, right) => left.id.localeCompare(right.id))
    const operations =
      plan.fileOperations === undefined
        ? undefined
        : [...plan.fileOperations].sort(
            (left, right) =>
              left.projectId.localeCompare(right.projectId) ||
              left.path.localeCompare(right.path) ||
              left.kind.localeCompare(right.kind),
          )
    if (
      plan.projects.some(
        (project) => parseProjectRelativePath(project.configFileName) !== project.configFileName,
      ) ||
      plan.sources.some(
        (source) => parseProjectRelativePath(source.fileName) !== source.fileName,
      ) ||
      plan.edits.some((edit) => parseProjectRelativePath(edit.fileName) !== edit.fileName) ||
      (plan.fileOperations ?? []).some(
        (operation) =>
          parseProjectRelativePath(operation.path) !== operation.path ||
          (operation.kind === "move" &&
            parseProjectRelativePath(operation.toPath) !== operation.toPath),
      )
    ) {
      return yield* fail("invalid-plan", "Paths are not canonical")
    }
    if (
      JSON.stringify(plan.projects) !== JSON.stringify(projects) ||
      JSON.stringify(plan.sources) !== JSON.stringify(sources) ||
      JSON.stringify(plan.edits) !== JSON.stringify(edits) ||
      JSON.stringify(plan.evidence) !== JSON.stringify(evidence) ||
      JSON.stringify(plan.fileOperations) !== JSON.stringify(operations)
    ) {
      return yield* fail("invalid-plan", "Plan arrays are not canonical")
    }
    for (const edit of plan.edits) {
      if (JSON.stringify(edit.evidenceIds) !== JSON.stringify([...edit.evidenceIds].sort()))
        return yield* fail("invalid-plan", "Evidence IDs are not canonical")
    }
    for (const operation of plan.fileOperations ?? []) {
      if (
        operation.evidenceIds !== undefined &&
        JSON.stringify(operation.evidenceIds) !== JSON.stringify([...operation.evidenceIds].sort())
      ) {
        return yield* fail("invalid-plan", "Evidence IDs are not canonical")
      }
    }
    for (let index = 1; index < plan.edits.length; index++) {
      if (editsConflict(plan.edits[index - 1]!, plan.edits[index]!))
        return yield* fail("edit-conflict", "Overlapping edits")
    }
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
  sources: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      fileName: Schema.String,
      hash: Schema.String,
    }),
  ),
  snapshotHash: Schema.String,
  edits: Schema.Array(TextEditSchema),
  fileOperations: Schema.optional(Schema.Array(FileOperationSchema)),
  evidence: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      facts: Schema.Record(Schema.String, Schema.Json),
    }),
  ),
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

const decodePlan = (decoded: unknown): Effect.Effect<TransformationPlan, PlanDecodeError> =>
  hasExactFileOperationFields(decoded)
    ? Schema.decodeUnknownEffect(TransformationPlanSchema)(decoded).pipe(
        Effect.mapError(() => new PlanDecodeError({ reason: "schema" })),
        Effect.map((value) => value as unknown as TransformationPlan),
      )
    : Effect.fail(new PlanDecodeError({ reason: "schema" }))

export const parsePlan = (text: string): Effect.Effect<TransformationPlan, PlanDecodeError> =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => new PlanDecodeError({ reason: "json" })),
    Effect.flatMap(decodePlan),
    Effect.flatMap((decoded) =>
      Effect.gen(function* () {
        // SAFETY: decodePlan validates all structural fields and validateDecodedPlan
        // checks/canonicalizes the branded project-relative operation paths.
        const plan = decoded as TransformationPlan
        if (text !== canonicalJson(asJson(plan)))
          return yield* new PlanDecodeError({ reason: "schema" })
        const semantic = yield* validateDecodedPlan(plan).pipe(
          Effect.mapError(() => new PlanDecodeError({ reason: "schema" })),
        )
        void semantic
        if (digest(canonicalJson(withoutId(plan))) !== plan.planId) {
          return yield* new PlanDecodeError({ reason: "hash" })
        }
        return plan
      }),
    ),
  )
