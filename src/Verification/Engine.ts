/** Verification and application service engine. */
import { Data, Effect, FileSystem, Path, Predicate } from "effect"
import { textHash } from "../Edit/index.ts"
import type { AllowedError, DiagnosticDiff, DiagnosticRecord } from "../Policy/index.ts"
import {
  isContentFingerprint,
  type PlanDecodeError,
  type SourceFingerprint,
  validatePlan,
  type TransformationPlan,
} from "../Plan/index.ts"
import { hashDirectoryListing } from "../Workspace/index.ts"
import {
  materialize as materializeVirtualFs,
  virtualFileKey,
  type VirtualFsInitialFile,
  VirtualFsError,
} from "../VirtualFs/index.ts"
import { isProjectRelativePath, parseProjectRelativePath } from "../ProjectPath/index.ts"
import {
  evaluateBuiltInPolicies,
  failureFromPolicyResults,
  type PolicyFailure,
  type PolicyResult,
} from "./PolicyEvaluation.ts"

export type { PolicyResult } from "./PolicyEvaluation.ts"

export class StalePlanError extends Data.TaggedError("StalePlanError")<{
  readonly planId: string
  readonly projectId: string
  readonly fileName: string
}> {}

export class VerificationFailure extends Data.TaggedError("VerificationFailure")<{
  readonly planId: string
  readonly policy: "edits" | "matches" | "affected-files" | "diagnostics" | "idempotence"
  readonly detail: string
  /** Diagnostics relevant to the failed policy, including source locations. */
  readonly diagnostics?: ReadonlyArray<DiagnosticRecord> | undefined
}> {}

const verificationFailure = (planId: string, failure: PolicyFailure): VerificationFailure =>
  failure.diagnostics === undefined
    ? new VerificationFailure({
        planId,
        policy: failure.policy,
        detail: failure.detail,
      })
    : new VerificationFailure({
        planId,
        policy: failure.policy,
        detail: failure.detail,
        diagnostics: failure.diagnostics,
      })

/** A plan's project identities are not the live Workspace definition. */
export class ProjectIdentityMismatch extends Data.TaggedError("ProjectIdentityMismatch")<{
  readonly planId: string
  readonly expected: ReadonlyArray<{ readonly id: string; readonly config: string }>
  readonly actual: ReadonlyArray<{ readonly id: string; readonly config: string }>
}> {}

export type FileState =
  | { readonly exists: false; readonly text?: undefined; readonly hash?: undefined }
  | { readonly exists: true; readonly text: string; readonly hash: string }

export interface FilePreview {
  readonly projectId: string
  readonly fileName: string
  /** Explicit operation and virtual existence state; empty text is valid content. */
  readonly action: "create" | "modify" | "delete" | "move"
  readonly before: FileState
  readonly after: FileState
  /** The counterpart path for a move operation, when applicable. */
  readonly movePath?: string | undefined
}

export interface PlanPreview {
  readonly planId: string
  readonly snapshotHash: string
  readonly files: ReadonlyArray<FilePreview>
}

export interface VerificationObservation {
  readonly actualMatches: number
  readonly baselineErrorCount: number
  readonly proposedErrorCount: number
  readonly secondPlanChangeCount?: number
  readonly diagnosticDiff: DiagnosticDiff
  readonly policyResults?: ReadonlyArray<PolicyResult>
  readonly allowedErrors?: ReadonlyArray<AllowedError>
}

export interface VerificationReceipt {
  readonly planId: string
  readonly snapshotHash: string
  readonly affectedFiles: number
  readonly actualMatches: number
  readonly baselineErrorCount: number
  readonly proposedErrorCount: number
  readonly diagnosticDelta: number
  readonly idempotenceChecked: boolean
  readonly policyResults: ReadonlyArray<PolicyResult>
}

// Process-local token. Symbol.for would be forgeable across the isolate.
const VerifiedPlanTypeId: unique symbol = Symbol("@safemods/internal/VerifiedPlan")

export interface VerifiedPlan {
  readonly [VerifiedPlanTypeId]: typeof VerifiedPlanTypeId
  readonly plan: TransformationPlan
  readonly preview: PlanPreview
  readonly receipt: VerificationReceipt
}

interface IssuedVerifiedPlan {
  readonly plan: TransformationPlan
  readonly preview: PlanPreview
  readonly receipt: VerificationReceipt
}

const issuedVerifiedPlans = new WeakMap<VerifiedPlan, IssuedVerifiedPlan>()

const freezeDeep = <A>(value: A): A => {
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item)
    return Object.freeze(value)
  }
  if (value !== null && Predicate.isObject(value)) {
    for (const item of Object.values(value)) freezeDeep(item)
    return Object.freeze(value)
  }
  return value
}

const issueVerifiedPlan = (
  plan: TransformationPlan,
  preview: PlanPreview,
  receipt: VerificationReceipt,
  diagnosticDiff: DiagnosticDiff,
): VerifiedPlan & { readonly diagnosticDiff: DiagnosticDiff } => {
  const issuedPlan = freezeDeep(structuredClone(plan))
  const issuedPreview = freezeDeep(structuredClone(preview))
  const issuedReceipt = freezeDeep(structuredClone(receipt))
  const verified: VerifiedPlan & { readonly diagnosticDiff: DiagnosticDiff } = {
    [VerifiedPlanTypeId]: VerifiedPlanTypeId,
    plan: issuedPlan,
    preview: issuedPreview,
    receipt: issuedReceipt,
    diagnosticDiff: freezeDeep(structuredClone(diagnosticDiff)),
  }
  Object.freeze(verified)
  issuedVerifiedPlans.set(verified, {
    plan: issuedPlan,
    preview: issuedPreview,
    receipt: issuedReceipt,
  })
  return verified
}

/** Contents of a VerifiedPlan minted by successful verification, if any. */
export const issuedVerifiedPlan = (verified: VerifiedPlan): IssuedVerifiedPlan | undefined =>
  issuedVerifiedPlans.get(verified)

const liveProjectIdentities = (
  projects: ReadonlyArray<{ readonly id: string; readonly config: string }>,
): ReadonlyArray<{ readonly id: string; readonly config: string }> =>
  [...projects]
    .map((project) => ({ id: project.id, config: project.config }))
    .sort((left, right) => left.id.localeCompare(right.id))

const planProjectIdentities = (
  plan: TransformationPlan,
): ReadonlyArray<{ readonly id: string; readonly config: string }> =>
  [...plan.projects]
    .map((project) => ({ id: project.id, config: project.configFileName }))
    .sort((left, right) => left.id.localeCompare(right.id))

const sameIdentities = (
  expected: ReadonlyArray<{ readonly id: string; readonly config: string }>,
  actual: ReadonlyArray<{ readonly id: string; readonly config: string }>,
): boolean =>
  expected.length === actual.length &&
  expected.every(
    (project, index) =>
      project.id === actual[index]?.id && project.config === actual[index]?.config,
  )

export const requireMatchingProjectIdentity = (
  plan: TransformationPlan,
  liveProjects: ReadonlyArray<{ readonly id: string; readonly config: string }>,
): Effect.Effect<void, ProjectIdentityMismatch> => {
  const expected = liveProjectIdentities(liveProjects)
  const actual = planProjectIdentities(plan)
  if (sameIdentities(expected, actual)) return Effect.void
  return Effect.fail(
    new ProjectIdentityMismatch({
      planId: plan.planId,
      expected,
      actual,
    }),
  )
}

const absoluteFileName = (
  plan: TransformationPlan,
  workspaceRoot: string,
  projectId: string,
  fileName: string,
): Effect.Effect<string, VerificationFailure, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const project = plan.projects.find((candidate) => candidate.id === projectId)
    if (
      project === undefined ||
      !isProjectRelativePath(fileName) ||
      !isProjectRelativePath(project.configFileName)
    ) {
      return yield* new VerificationFailure({
        planId: plan.planId,
        policy: "edits",
        detail: `Unsafe or unknown project path: ${projectId}:${fileName}`,
      })
    }
    return path.resolve(workspaceRoot, path.dirname(project.configFileName), fileName)
  })

const staleSource = (planId: string, source: SourceFingerprint): StalePlanError =>
  new StalePlanError({
    planId,
    projectId: source.projectId,
    fileName: source.fileName,
  })

const revalidateSource = (
  plan: TransformationPlan,
  workspaceRoot: string,
  source: SourceFingerprint,
): Effect.Effect<
  string | undefined,
  StalePlanError | VerificationFailure,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const stale = staleSource(plan.planId, source)
    const absolute = yield* absoluteFileName(plan, workspaceRoot, source.projectId, source.fileName)
    const fs = yield* FileSystem.FileSystem
    if (source.kind === "missing") {
      const exists = yield* fs.exists(absolute).pipe(Effect.mapError(() => stale))
      if (exists) return yield* stale
      return undefined
    }
    if (source.kind === "directory") {
      const names = yield* fs.readDirectory(absolute).pipe(Effect.mapError(() => stale))
      if (hashDirectoryListing(names) !== source.hash) return yield* stale
      return undefined
    }
    if (source.kind === "realpath") {
      const resolved = yield* fs.realPath(absolute).pipe(Effect.mapError(() => stale))
      const project = plan.projects.find((candidate) => candidate.id === source.projectId)
      if (project === undefined) return yield* stale
      const path = yield* Path.Path
      const projectRoot = path.resolve(workspaceRoot, path.dirname(project.configFileName))
      const realRoot = yield* fs.realPath(projectRoot).pipe(Effect.orElseSucceed(() => projectRoot))
      const relative = parseProjectRelativePath(
        path.relative(realRoot, resolved).split(path.sep).join("/"),
      )
      if (relative === undefined || textHash(relative) !== source.hash) return yield* stale
      return undefined
    }
    const content = yield* fs.readFileString(absolute).pipe(Effect.mapError(() => stale))
    if (textHash(content) !== source.hash) return yield* stale
    return content
  })

export const revalidatePlanSources = (
  plan: TransformationPlan,
  workspaceRoot: string,
): Effect.Effect<void, StalePlanError | VerificationFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    for (const source of plan.sources) {
      yield* revalidateSource(plan, workspaceRoot, source)
    }
  })

export const previewPlan = (
  plan: TransformationPlan,
  workspaceRoot: string,
): Effect.Effect<
  PlanPreview,
  StalePlanError | VerificationFailure | PlanDecodeError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const validated = yield* validatePlan(plan)
    const path = yield* Path.Path
    const initialFiles: Array<VirtualFsInitialFile> = []
    const initial = new Map<string, string>()
    for (const source of validated.sources) {
      const content = yield* revalidateSource(validated, workspaceRoot, source)
      if (!isContentFingerprint(source) || content === undefined) continue
      initialFiles.push({
        projectId: source.projectId,
        fileName: source.fileName,
        content,
      })
      initial.set(virtualFileKey(source.projectId, source.fileName), content)
    }

    const resolvePath = (projectId: string, fileName: string): string => {
      const project = validated.projects.find((candidate) => candidate.id === projectId)
      if (
        project === undefined ||
        !isProjectRelativePath(fileName) ||
        !isProjectRelativePath(project.configFileName)
      ) {
        throw new Error(`Unsafe or unknown project path: ${projectId}:${fileName}`)
      }
      return path.resolve(workspaceRoot, path.dirname(project.configFileName), fileName)
    }

    const materialized = yield* materializeVirtualFs<never>({
      initialFiles,
      // Every source used by a valid plan is fingerprinted above. This loader
      // is only a defensive boundary for malformed plans.
      load: (projectId, fileName) =>
        Effect.die(new Error(`Missing fingerprint for ${projectId}:${fileName}`)),
      resolvePath,
      edits: validated.edits,
      fileOperations: validated.fileOperations,
    }).pipe(
      Effect.mapError((error) => {
        if (error instanceof VirtualFsError) {
          if (error.reason === "source-mismatch") {
            return new StalePlanError({
              planId: validated.planId,
              projectId: error.projectId,
              fileName: error.fileName,
            })
          }
          return new VerificationFailure({
            planId: validated.planId,
            policy: "edits",
            detail: `Missing source for ${error.projectId}\\0${error.fileName}`,
          })
        }
        return new VerificationFailure({
          planId: validated.planId,
          policy: "edits",
          detail: error._tag,
        })
      }),
    )

    const touched = new Set<string>()
    const moveCounterpart = new Map<string, string>()
    const operationKinds = new Map<string, "create" | "delete" | "move">()
    for (const op of validated.fileOperations ?? []) {
      const sourceKey = virtualFileKey(op.projectId, op.path)
      touched.add(sourceKey)
      if (op.kind === "create") {
        operationKinds.set(sourceKey, "create")
      } else if (op.kind === "delete") {
        operationKinds.set(sourceKey, "delete")
      } else {
        const targetKey = virtualFileKey(op.projectId, op.toPath)
        touched.add(targetKey)
        operationKinds.set(sourceKey, "move")
        operationKinds.set(targetKey, "move")
        moveCounterpart.set(sourceKey, op.toPath)
        moveCounterpart.set(targetKey, op.path)
      }
    }

    for (const edit of validated.edits) {
      touched.add(virtualFileKey(edit.projectId, edit.fileName))
    }

    const filesByKey = new Map<string, FilePreview>()
    const stateOf = (text: string | undefined): FileState =>
      text === undefined ? { exists: false } : { exists: true, text, hash: textHash(text) }
    for (const key of touched) {
      // SAFETY: every virtualFileKey is created from exactly one project ID and file name.
      const [projectId, fileName] = key.split("\0") as [string, string]
      const absolute = resolvePath(projectId, fileName)
      const before = initial.get(key)
      const after = materialized.deleted.has(absolute)
        ? undefined
        : materialized.files.get(absolute)
      const operation = operationKinds.get(key)
      const action = operation ?? (before === undefined ? "create" : "modify")
      filesByKey.set(key, {
        projectId,
        fileName,
        action,
        before: stateOf(before),
        after: stateOf(after),
        movePath: moveCounterpart.get(key),
      })
    }

    const files = [...filesByKey.values()]
    files.sort(
      (left, right) =>
        left.projectId.localeCompare(right.projectId) ||
        left.fileName.localeCompare(right.fileName),
    )
    return { planId: validated.planId, snapshotHash: validated.snapshotHash, files }
  })

export const verifyPreview = (
  plan: TransformationPlan,
  preview: PlanPreview,
  observation: VerificationObservation,
): Effect.Effect<
  VerifiedPlan & { readonly diagnosticDiff: DiagnosticDiff },
  VerificationFailure | PlanDecodeError
> =>
  Effect.gen(function* () {
    const builtIn = evaluateBuiltInPolicies({
      policies: plan.policies,
      actualMatches: observation.actualMatches,
      affectedFiles: preview.files.length,
      baselineErrorCount: observation.baselineErrorCount,
      proposedErrorCount: observation.proposedErrorCount,
      diagnosticDiff: observation.diagnosticDiff,
      secondPlanChangeCount: observation.secondPlanChangeCount,
      allowedErrors: observation.allowedErrors,
    })
    if (builtIn.failure !== undefined) {
      return yield* verificationFailure(plan.planId, builtIn.failure)
    }

    // Do not mint a VerifiedPlan containing a failed built-in result, even when
    // a caller constructed the observation directly rather than going through
    // Core's policy checks above.
    const reportedFailure = failureFromPolicyResults(
      observation.policyResults,
      observation.diagnosticDiff,
    )
    if (reportedFailure !== undefined) {
      return yield* verificationFailure(plan.planId, reportedFailure)
    }

    const receipt: VerificationReceipt = {
      planId: plan.planId,
      snapshotHash: plan.snapshotHash,
      affectedFiles: preview.files.length,
      actualMatches: observation.actualMatches,
      baselineErrorCount: observation.baselineErrorCount,
      proposedErrorCount: observation.proposedErrorCount,
      diagnosticDelta: observation.proposedErrorCount - observation.baselineErrorCount,
      idempotenceChecked: plan.policies.idempotence === "required",
      policyResults: observation.policyResults ?? [],
    }
    const validated = yield* validatePlan(plan)
    return issueVerifiedPlan(validated, preview, receipt, observation.diagnosticDiff)
  })
