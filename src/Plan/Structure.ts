/** Authoritative runtime structure for schema-version 1 transformation plans. */
import { Schema } from "effect"

const RecipeSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  implementationHash: Schema.String,
  options: Schema.Json,
})

const ToolchainSchema = Schema.Struct({
  systemVersion: Schema.String,
  typescriptVersion: Schema.String,
  effectVersion: Schema.String,
})

const ProjectEvidenceSchema = Schema.Struct({
  id: Schema.String,
  configFileName: Schema.String,
})

const SourceFingerprintSchema = Schema.Struct({
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
})

const NonNegativeInt = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

const TextEditSchema = Schema.Struct({
  projectId: Schema.String,
  fileName: Schema.String,
  start: NonNegativeInt,
  end: NonNegativeInt,
  expectedTextHash: Schema.String,
  newText: Schema.String,
  evidenceIds: Schema.Array(Schema.String),
})

const FileOperationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create"),
    projectId: Schema.String,
    path: Schema.String,
    content: Schema.String,
    evidenceIds: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("delete"),
    projectId: Schema.String,
    path: Schema.String,
    initialHash: Schema.String,
    evidenceIds: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("move"),
    projectId: Schema.String,
    path: Schema.String,
    toPath: Schema.String,
    content: Schema.optional(Schema.String),
    initialHash: Schema.String,
    evidenceIds: Schema.optional(Schema.Array(Schema.String)),
  }),
])

const EvidenceRecordSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  facts: Schema.Record(Schema.String, Schema.Json),
})

const PoliciesSchema = Schema.Struct({
  matchCount: Schema.Struct({
    min: Schema.optional(NonNegativeInt),
    max: Schema.optional(NonNegativeInt),
  }).check(
    Schema.makeFilter(
      (count: { readonly min?: number | undefined; readonly max?: number | undefined }) =>
        count.min === undefined || count.max === undefined || count.min <= count.max,
      { expected: "matchCount.min <= matchCount.max" },
    ),
  ),
  maxAffectedFiles: Schema.optional(NonNegativeInt),
  diagnostics: Schema.Union([Schema.Literal("no-new-errors"), Schema.Literal("exact-delta")]),
  idempotence: Schema.Union([Schema.Literal("required"), Schema.Literal("not-promised")]),
})

const MeasurementsSchema = Schema.Struct({ matches: Schema.optional(NonNegativeInt) })

const planContentFields = {
  recipe: RecipeSchema,
  toolchain: ToolchainSchema,
  projects: Schema.Array(ProjectEvidenceSchema),
  sources: Schema.Array(SourceFingerprintSchema),
  edits: Schema.Array(TextEditSchema),
  fileOperations: Schema.optional(Schema.Array(FileOperationSchema)),
  evidence: Schema.Array(EvidenceRecordSchema),
  policies: PoliciesSchema,
  measurements: Schema.optional(MeasurementsSchema),
}

export const PlanInputSchema = Schema.Struct(planContentFields)

/** Complete durable-plan structure. Semantic and canonical checks live in Validate. */
export const TransformationPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  planId: Schema.String,
  ...planContentFields,
  snapshotHash: Schema.String,
})

/** All plan structs are closed so every boundary rejects fields it cannot address. */
export const strictPlanParseOptions = { onExcessProperty: "error" } as const
