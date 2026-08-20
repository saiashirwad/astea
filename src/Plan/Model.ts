/** Durable Plan domain values and errors. */
import { Data } from "effect"
import type { EvidenceRecord, Json } from "../Evidence/Core.ts"
import type { TextEdit } from "../Edit/index.ts"
import type { ProjectRelativePath } from "../ProjectPath/index.ts"

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
