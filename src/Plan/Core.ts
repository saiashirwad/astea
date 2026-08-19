/** Plan domain — canonical, serializable transformation plans. */
import { createHash } from "node:crypto"
import { Data, Effect, Predicate, Schema } from "effect"
import type { EvidenceRecord, Json } from "../Evidence/Core.ts"
import { compareEdits, editsConflict, type TextEdit } from "../Edit/index.ts"
import { parseProjectRelativePath, type ProjectRelativePath } from "../Workspace/ProjectPath.ts"

export type { Json } from "../Evidence/Core.ts"
export type { TextEdit } from "../Edit/index.ts"

export interface ProjectEvidence {
  readonly id: string
  readonly configFileName: string
}

export type SourceFingerprintKind = "file" | "missing" | "directory" | "realpath"

export interface SourceFingerprint {
  readonly projectId: string
  readonly fileName: string
  readonly hash: string
  /** Absent or `"file"` is a content hash. Other kinds are non-source observations. */
  readonly kind?: SourceFingerprintKind | undefined
}

export const isContentFingerprint = (source: SourceFingerprint): boolean =>
  source.kind === undefined || source.kind === "file"

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

export type { EvidenceRecord } from "../Evidence/Core.ts"

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

/** Input boundary before the content-addressed fields are assigned. */
export interface PlanInput {
  readonly recipe: TransformationPlan["recipe"]
  readonly toolchain: TransformationPlan["toolchain"]
  readonly projects: ReadonlyArray<ProjectEvidence>
  readonly sources: ReadonlyArray<SourceFingerprint>
  readonly edits: ReadonlyArray<TextEdit>
  readonly fileOperations?: ReadonlyArray<PlannedFileOperation> | undefined
  readonly evidence: ReadonlyArray<EvidenceRecord>
  readonly policies: PlanPolicies
  readonly measurements?: PlanMeasurements | undefined
}

type Inspectable =
  | Json
  | ReadonlyArray<Json>
  | PlanInput
  | PlannedFileOperation
  | ProjectEvidence
  | SourceFingerprint
  | TextEdit
  | EvidenceRecord
  | undefined

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

const isFiniteNonnegativeInteger = (value: Inspectable): value is number =>
  Predicate.isNumber(value) && Number.isFinite(value) && Number.isInteger(value) && value >= 0

const isReadonlyArray = (value: Inspectable): value is ReadonlyArray<Json> => Array.isArray(value)

const isRecord = (value: Inspectable): value is Readonly<Record<string, Json>> =>
  Predicate.isObject(value)

const isStringArray = (value: Inspectable): value is ReadonlyArray<string> =>
  isReadonlyArray(value) && value.every(Predicate.isString)

const isProjectEvidence = (value: Inspectable): value is ProjectEvidence =>
  isRecord(value) && Predicate.isString(value.id) && Predicate.isString(value.configFileName)

const isSourceFingerprintKind = (value: Inspectable): value is SourceFingerprintKind =>
  value === "file" || value === "missing" || value === "directory" || value === "realpath"

const isSourceFingerprint = (value: Inspectable): value is SourceFingerprint =>
  isRecord(value) &&
  Predicate.isString(value.projectId) &&
  Predicate.isString(value.fileName) &&
  Predicate.isString(value.hash) &&
  (value.kind === undefined || isSourceFingerprintKind(value.kind))

const isTextEdit = (value: Inspectable): value is TextEdit =>
  isRecord(value) &&
  Predicate.isString(value.projectId) &&
  Predicate.isString(value.fileName) &&
  Predicate.isNumber(value.start) &&
  Predicate.isNumber(value.end) &&
  Predicate.isString(value.expectedTextHash) &&
  Predicate.isString(value.newText) &&
  isStringArray(value.evidenceIds)

const isEvidenceRecord = (value: Inspectable): value is EvidenceRecord =>
  isRecord(value) &&
  Predicate.isString(value.id) &&
  Predicate.isString(value.kind) &&
  isRecord(value.facts)

const isPlannedFileOperation = (value: Inspectable): value is PlannedFileOperation => {
  if (!hasExactOperationFields(value) || !isRecord(value)) return false
  if (
    !Predicate.isString(value.projectId) ||
    !Predicate.isString(value.path) ||
    !isStringArray(value.evidenceIds ?? [])
  )
    return false
  if (value.kind === "create") return Predicate.isString(value.content)
  if (value.kind === "delete") return Predicate.isString(value.initialHash)
  return (
    Predicate.isString(value.toPath) &&
    Predicate.isString(value.initialHash) &&
    (value.content === undefined || Predicate.isString(value.content))
  )
}

const isPlanInput = (value: Inspectable): value is PlanInput => {
  if (!isRecord(value) || !isRecord(value.recipe) || !isRecord(value.toolchain)) return false
  if (
    !Predicate.isString(value.recipe.name) ||
    !Predicate.isString(value.recipe.version) ||
    !Predicate.isString(value.recipe.implementationHash) ||
    !Predicate.isString(value.toolchain.systemVersion) ||
    !Predicate.isString(value.toolchain.typescriptVersion) ||
    !Predicate.isString(value.toolchain.effectVersion) ||
    !isReadonlyArray(value.projects) ||
    !value.projects.every(isProjectEvidence) ||
    !isReadonlyArray(value.sources) ||
    !value.sources.every(isSourceFingerprint) ||
    !isReadonlyArray(value.edits) ||
    !value.edits.every(isTextEdit) ||
    !isReadonlyArray(value.evidence) ||
    !value.evidence.every(isEvidenceRecord) ||
    (value.fileOperations !== undefined &&
      (!isReadonlyArray(value.fileOperations) ||
        !value.fileOperations.every(isPlannedFileOperation))) ||
    !isRecord(value.policies) ||
    !isRecord(value.policies.matchCount)
  )
    return false
  return (
    (value.measurements === undefined || isRecord(value.measurements)) &&
    (value.policies.diagnostics === "no-new-errors" ||
      value.policies.diagnostics === "exact-delta") &&
    (value.policies.idempotence === "required" || value.policies.idempotence === "not-promised")
  )
}

const compareSourceFingerprints = (left: SourceFingerprint, right: SourceFingerprint): number =>
  left.projectId.localeCompare(right.projectId) ||
  left.fileName.localeCompare(right.fileName) ||
  (left.kind ?? "file").localeCompare(right.kind ?? "file")

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

const hasExactOperationFields = (operation: Inspectable): operation is PlannedFileOperation => {
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
    if (!isPlanInput(input)) {
      return yield* fail("invalid-plan", "Plan shape is invalid")
    }
    const projectIds = new Set<string>()
    for (const project of input.projects) {
      if (!Predicate.isString(project.id) || project.id.length === 0 || projectIds.has(project.id)) {
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
    const seenSources = new Set<string>()
    for (const source of input.sources) {
      const path = normalizedPath(source.fileName)
      if (path === undefined) return yield* fail("invalid-path", source.fileName)
      if (!projectIds.has(source.projectId)) return yield* fail("missing-source", source.fileName)
      const kind = source.kind ?? "file"
      const unique = `${source.projectId}\0${kind}\0${path}`
      if (seenSources.has(unique)) return yield* fail("duplicate-source", source.fileName)
      seenSources.add(unique)
      const normalized = { ...source, fileName: path }
      if (isContentFingerprint(normalized))
        sourceMap.set(`${source.projectId}\0${path}`, normalized)
    }
    const evidenceIds = new Set<string>()
    for (const item of input.evidence) {
      if (!Predicate.isString(item.id) || item.id.length === 0 || evidenceIds.has(item.id)) {
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
      .sort(compareSourceFingerprints)
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

/** Reject a structurally decoded plan that is not canonical or content-addressed. */
export const validatePlan = (
  plan: TransformationPlan,
): Effect.Effect<TransformationPlan, PlanDecodeError> =>
  Effect.gen(function* () {
    yield* validateDecodedPlan(plan).pipe(
      Effect.mapError(() => new PlanDecodeError({ reason: "schema" })),
    )
    if (digest(canonicalJson(withoutId(plan))) !== plan.planId) {
      return yield* new PlanDecodeError({ reason: "hash" })
    }
    return plan
  })

const TextEditSchema = Schema.Struct({
  projectId: Schema.String,
  fileName: Schema.String,
  start: Schema.Finite,
  end: Schema.Finite,
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

const hasExactFileOperationFields = (value: Inspectable): boolean => {
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
    const sources = [...plan.sources].sort(compareSourceFingerprints)
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
      kind: Schema.optional(
        Schema.Union([
          Schema.Literal("file"),
          Schema.Literal("missing"),
          Schema.Literal("directory"),
          Schema.Literal("realpath"),
        ]),
      ),
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
      min: Schema.optional(Schema.Finite),
      max: Schema.optional(Schema.Finite),
    }),
    maxAffectedFiles: Schema.optional(Schema.Finite),
    diagnostics: Schema.Union([Schema.Literal("no-new-errors"), Schema.Literal("exact-delta")]),
    idempotence: Schema.Union([Schema.Literal("required"), Schema.Literal("not-promised")]),
  }),
  measurements: Schema.optional(Schema.Struct({ matches: Schema.optional(Schema.Finite) })),
})

const decodePlan = (decoded: Inspectable): Effect.Effect<TransformationPlan, PlanDecodeError> =>
  hasExactFileOperationFields(decoded)
    ? Schema.decodeUnknownEffect(TransformationPlanSchema)(decoded).pipe(
        Effect.mapError(() => new PlanDecodeError({ reason: "schema" })),
        Effect.map((value) => {
          // SAFETY: the schema validates every field; branded path types are runtime strings.
          return value as TransformationPlan
        }),
      )
    : Effect.fail(new PlanDecodeError({ reason: "schema" }))

export const parsePlan = (text: string): Effect.Effect<TransformationPlan, PlanDecodeError> =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
    Effect.mapError(() => new PlanDecodeError({ reason: "json" })),
    Effect.flatMap(decodePlan),
    Effect.flatMap((decoded) =>
      Effect.gen(function* () {
        // SAFETY: decodePlan validates all structural fields and validateDecodedPlan
        // checks/canonicalizes the branded project-relative operation paths.
        const plan = decoded
        if (text !== canonicalJson(asJson(plan)))
          return yield* new PlanDecodeError({ reason: "schema" })
        yield* validateDecodedPlan(plan).pipe(
          Effect.mapError(() => new PlanDecodeError({ reason: "schema" })),
        )
        if (digest(canonicalJson(withoutId(plan))) !== plan.planId) {
          return yield* new PlanDecodeError({ reason: "hash" })
        }
        return plan
      }),
    ),
  )
