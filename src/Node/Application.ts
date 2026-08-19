import { randomUUID } from "node:crypto"
import { Effect, FileSystem, Layer, Path, Predicate, Semaphore } from "effect"
import {
  ApplicationFailure,
  ApplicationIndeterminate,
  PlanApplication,
} from "../Application/Model.ts"
import { textHash } from "../Edit/index.ts"
import type { Json, TransformationPlan } from "../Plan/index.ts"
import {
  issuedVerifiedPlan,
  previewPlan,
  requireMatchingProjectIdentity,
  revalidatePlanSources,
  StalePlanError,
  type FilePreview,
  type VerifiedPlan,
} from "../Verification/Engine.ts"
import { isProjectRelativePath } from "../Workspace/ProjectPath.ts"
import { Workspace, type WorkspaceDefinition } from "../Workspace/index.ts"
import { layer as nodeLayer } from "../platform/node.ts"

/** Node filesystem implementation of the sole write-authority service. */
export const applicationLayerNode: Layer.Layer<
  PlanApplication | FileSystem.FileSystem | Path.Path,
  never,
  Workspace
> = Layer.unwrap(
  Workspace.use((workspace) => Effect.succeed(makeApplicationLayerNode(workspace.root))),
)

/** Node-backed application service without leaking filesystem authority upward. */
export const makeApplicationLayerNode = (
  workspaceRoot: string,
): Layer.Layer<PlanApplication | FileSystem.FileSystem | Path.Path, never, Workspace> =>
  Layer.merge(applicationLayer(workspaceRoot), nodeLayer)

const isContained = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

const asApplicationFailure = (
  planId: string,
  cause: unknown,
  rolledBack = false,
): ApplicationFailure => new ApplicationFailure({ planId, cause, rolledBack })

const APPLY_LOCK_NAME = ".safemods-apply.lock"
const APPLY_JOURNAL_NAME = ".safemods-apply.journal"

const isSafemodsTemporaryName = (name: string): boolean =>
  name.includes(".safemods-") && name.endsWith(".tmp")

const processExists = (pid: number): boolean => {
  try {
    // Signal 0 does not kill; it reports whether the lock owner is alive.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

interface JournalBeforeState {
  readonly exists: boolean
  readonly text?: string
}

interface JournalEntry {
  readonly target: string
  readonly temporary?: string
  readonly before: JournalBeforeState
}

interface TransactionJournal {
  readonly planId: string
  readonly phase: "open" | "committed"
  readonly files: ReadonlyArray<JournalEntry>
  readonly createdDirectories: ReadonlyArray<string>
}

const asRecord = (value: Json): Readonly<Record<string, Json>> | undefined => {
  if (!Predicate.isObject(value)) return undefined
  return value
}

const parseJournalBefore = (value: Json): JournalBeforeState | undefined => {
  const record = asRecord(value)
  if (record === undefined || !Predicate.isBoolean(record.exists)) return undefined
  if (!record.exists) return { exists: false }
  if (record.text !== undefined && !Predicate.isString(record.text)) return undefined
  return { exists: true, text: Predicate.isString(record.text) ? record.text : "" }
}

const parseJournalEntry = (value: Json): JournalEntry | undefined => {
  const record = asRecord(value)
  if (record === undefined || !Predicate.isString(record.target)) return undefined
  const before = parseJournalBefore(record.before)
  if (before === undefined) return undefined
  if (record.temporary !== undefined && !Predicate.isString(record.temporary)) return undefined
  return {
    target: record.target,
    ...(Predicate.isString(record.temporary) ? { temporary: record.temporary } : {}),
    before,
  }
}

const parseJournal = (text: string): TransactionJournal | undefined => {
  let value: Json
  try {
    // SAFETY: journal files are persisted as JSON by persistJournal.
    value = JSON.parse(text) as Json
  } catch {
    return undefined
  }
  const record = asRecord(value)
  if (record === undefined || !Predicate.isString(record.planId) || !Array.isArray(record.files)) {
    return undefined
  }
  const files: Array<JournalEntry> = []
  for (const entry of record.files) {
    const parsed = parseJournalEntry(entry)
    if (parsed === undefined) return undefined
    files.push(parsed)
  }
  const createdDirectories = Array.isArray(record.createdDirectories)
    ? record.createdDirectories.filter(Predicate.isString)
    : []
  const phase = record.phase === "committed" ? "committed" : "open"
  return { planId: record.planId, phase, files, createdDirectories }
}

const resolveContainedPath = (
  path: Path.Path,
  workspaceRoot: string,
  candidate: string,
): string | undefined => {
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate)
  return isContained(path, workspaceRoot, resolved) ? resolved : undefined
}

const persistJournal = (
  journalPath: string,
  journal: TransactionJournal,
): Effect.Effect<void, ApplicationFailure, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const temporary = `${journalPath}.${randomUUID()}.tmp`
    yield* fs
      .writeFileString(temporary, JSON.stringify(journal), { flag: "wx" })
      .pipe(Effect.mapError((cause) => asApplicationFailure(journal.planId, cause)))
    yield* fs.rename(temporary, journalPath).pipe(
      Effect.mapError((cause) => asApplicationFailure(journal.planId, cause)),
      Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
    )
  })

const sweepSafemodsTemporaries = (
  workspaceRoot: string,
  planId: string,
): Effect.Effect<void, ApplicationFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = yield* fs
      .readDirectory(workspaceRoot, { recursive: true })
      .pipe(Effect.mapError((cause) => asApplicationFailure(planId, cause)))
    for (const name of names) {
      if (!isSafemodsTemporaryName(name)) continue
      const target = path.resolve(workspaceRoot, name)
      if (!isContained(path, workspaceRoot, target)) continue
      yield* fs.remove(target, { force: true }).pipe(Effect.ignore)
    }
  })

const restoreJournalEntry = (
  workspaceRoot: string,
  planId: string,
  entry: JournalEntry,
): Effect.Effect<void, ApplicationFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (entry.temporary !== undefined) {
      const temporary = resolveContainedPath(path, workspaceRoot, entry.temporary)
      if (temporary !== undefined) {
        yield* fs.remove(temporary, { force: true }).pipe(Effect.ignore)
      }
    }
    const target = resolveContainedPath(path, workspaceRoot, entry.target)
    if (target === undefined) {
      return yield* asApplicationFailure(planId, `Journal path escapes workspace: ${entry.target}`)
    }
    yield* entry.before.exists
      ? fs
          .writeFileString(target, entry.before.text ?? "")
          .pipe(Effect.mapError((cause) => asApplicationFailure(planId, cause)))
      : fs.remove(target, { force: true }).pipe(Effect.ignore)
  })

const recoverUnfinishedApplication = (
  workspaceRoot: string,
  planId: string,
): Effect.Effect<void, ApplicationFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const journalPath = path.join(workspaceRoot, APPLY_JOURNAL_NAME)
    const exists = yield* fs
      .exists(journalPath)
      .pipe(Effect.mapError((cause) => asApplicationFailure(planId, cause)))
    if (exists) {
      const text = yield* fs
        .readFileString(journalPath)
        .pipe(Effect.mapError((cause) => asApplicationFailure(planId, cause)))
      const journal = parseJournal(text)
      if (journal !== undefined && journal.phase !== "committed") {
        for (const entry of journal.files) {
          yield* restoreJournalEntry(workspaceRoot, planId, entry)
        }
        for (const directory of [...journal.createdDirectories].reverse()) {
          const target = resolveContainedPath(path, workspaceRoot, directory)
          if (target !== undefined) {
            yield* fs.remove(target, { force: true }).pipe(Effect.ignore)
          }
        }
      }
      yield* fs.remove(journalPath, { force: true }).pipe(Effect.ignore)
    }
    yield* sweepSafemodsTemporaries(workspaceRoot, planId)
  })

const acquireApplyLock = (
  workspaceRoot: string,
  planId: string,
): Effect.Effect<string, ApplicationFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const lockPath = path.join(workspaceRoot, APPLY_LOCK_NAME)
    const exists = yield* fs
      .exists(lockPath)
      .pipe(Effect.mapError((cause) => asApplicationFailure(planId, cause)))
    if (exists) {
      const owner = yield* fs.readFileString(lockPath).pipe(Effect.orElseSucceed(() => ""))
      const pid = Math.trunc(Number(owner.trim()))
      if (Number.isInteger(pid) && pid > 0 && processExists(pid)) {
        return yield* asApplicationFailure(planId, "Application lock is held")
      }
      yield* fs
        .remove(lockPath, { force: true })
        .pipe(Effect.mapError((cause) => asApplicationFailure(planId, cause)))
    }
    yield* fs
      .writeFileString(lockPath, String(process.pid), { flag: "wx" })
      .pipe(Effect.mapError(() => asApplicationFailure(planId, "Application lock is held")))
    return lockPath
  })

const withExclusiveApplyLock = <A, E, R>(
  workspaceRoot: string,
  planId: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ApplicationFailure, R | FileSystem.FileSystem | Path.Path> =>
  Effect.acquireUseRelease(
    acquireApplyLock(workspaceRoot, planId),
    () => body,
    (lockPath) =>
      FileSystem.FileSystem.use((fs) => fs.remove(lockPath, { force: true })).pipe(Effect.ignore),
  )

/**
 * Resolve a durable project-relative path and enforce both lexical and real
 * filesystem containment. The nearest existing parent check prevents a
 * symlinked directory from redirecting a valid-looking path outside the
 * project between plan decoding and application.
 */
const safeTarget = (
  plan: TransformationPlan,
  workspaceRoot: string,
  projectId: string,
  fileName: string,
): Effect.Effect<string, ApplicationFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const project = plan.projects.find((candidate) => candidate.id === projectId)
    if (
      project === undefined ||
      !isProjectRelativePath(fileName) ||
      !isProjectRelativePath(project.configFileName)
    ) {
      return yield* asApplicationFailure(
        plan.planId,
        `Unsafe or unknown project path: ${projectId}:${fileName}`,
      )
    }

    const root = path.resolve(workspaceRoot)
    const configFile = path.resolve(root, project.configFileName)
    const projectRoot = path.dirname(configFile)
    const target = path.resolve(projectRoot, fileName)
    if (
      !isContained(path, root, projectRoot) ||
      !isContained(path, projectRoot, target) ||
      target === projectRoot
    ) {
      return yield* asApplicationFailure(
        plan.planId,
        `Path escapes project: ${projectId}:${fileName}`,
      )
    }

    const realProjectRoot = yield* fs
      .realPath(projectRoot)
      .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause)))
    const realWorkspaceRoot = yield* fs
      .realPath(root)
      .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause)))
    if (!isContained(path, realWorkspaceRoot, realProjectRoot)) {
      return yield* asApplicationFailure(
        plan.planId,
        `Project root escapes workspace through symlink: ${projectId}`,
      )
    }
    let existingParent = path.dirname(target)
    while (
      !(yield* fs
        .exists(existingParent)
        .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause))))
    ) {
      if (existingParent === projectRoot) break
      const parent = path.dirname(existingParent)
      if (parent === existingParent || !isContained(path, projectRoot, parent)) {
        return yield* asApplicationFailure(
          plan.planId,
          `Path escapes project through parent: ${fileName}`,
        )
      }
      existingParent = parent
    }
    const realParent = yield* fs
      .realPath(existingParent)
      .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause)))
    if (!isContained(path, realProjectRoot, realParent)) {
      return yield* asApplicationFailure(
        plan.planId,
        `Path escapes project through symlink: ${fileName}`,
      )
    }

    const targetExists = yield* fs
      .exists(target)
      .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause)))
    if (targetExists) {
      const realTarget = yield* fs
        .realPath(target)
        .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause)))
      if (!isContained(path, realProjectRoot, realTarget)) {
        return yield* asApplicationFailure(
          plan.planId,
          `Target escapes project through symlink: ${fileName}`,
        )
      }
    }
    return target
  })

const checkExpectedState = (
  plan: TransformationPlan,
  workspaceRoot: string,
  file: FilePreview,
): Effect.Effect<string, StalePlanError | ApplicationFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const target = yield* safeTarget(plan, workspaceRoot, file.projectId, file.fileName)
    const exists = yield* fs
      .exists(target)
      .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause)))
    if (exists !== file.before.exists) {
      return yield* new StalePlanError({
        planId: plan.planId,
        projectId: file.projectId,
        fileName: file.fileName,
      })
    }
    if (exists) {
      const current = yield* fs.readFileString(target).pipe(
        Effect.mapError(
          () =>
            new StalePlanError({
              planId: plan.planId,
              projectId: file.projectId,
              fileName: file.fileName,
            }),
        ),
      )
      if (textHash(current) !== file.before.hash) {
        return yield* new StalePlanError({
          planId: plan.planId,
          projectId: file.projectId,
          fileName: file.fileName,
        })
      }
    }
    return target
  })

/** Install over an existing file without rename-over of the live name. */
const installExistingFile = (
  plan: TransformationPlan,
  file: FilePreview,
  temporary: string,
  target: string,
): Effect.Effect<void, StalePlanError | ApplicationFailure, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const stale = new StalePlanError({
      planId: plan.planId,
      projectId: file.projectId,
      fileName: file.fileName,
    })
    const fail = (cause: unknown) => asApplicationFailure(plan.planId, cause)
    // Vacate the live name by moving its bytes aside, then no-replace link
    // the staged inode. Never rename the staged file onto the live name —
    // that would replace a write that landed after the last hash check.
    const backup = `${target}.safemods-swap-${randomUUID()}.tmp`
    yield* fs.rename(target, backup).pipe(Effect.mapError(fail))
    const linked = yield* fs.link(temporary, target).pipe(Effect.result)
    if (linked._tag === "Failure") {
      const exists = yield* fs.exists(target).pipe(Effect.mapError(fail))
      if (!exists) {
        yield* fs.rename(backup, target).pipe(Effect.mapError(fail))
        return yield* fail(linked.failure)
      }
      yield* fs.remove(backup, { force: true }).pipe(Effect.ignore)
      return yield* stale
    }
    const moved = yield* fs.readFileString(backup).pipe(Effect.mapError(() => stale))
    if (textHash(moved) !== file.before.hash) {
      yield* fs.remove(target, { force: true }).pipe(Effect.ignore)
      yield* fs.rename(backup, target).pipe(Effect.mapError(fail))
      return yield* stale
    }
    yield* fs.remove(backup, { force: true }).pipe(Effect.ignore)
  })

interface StagedFile {
  readonly file: FilePreview
  readonly target: string
  readonly temporary?: string | undefined
}

const planIdOf = (verified: VerifiedPlan): string => {
  if (
    Predicate.isObject(verified) &&
    "plan" in verified &&
    Predicate.isObject(verified.plan) &&
    "planId" in verified.plan &&
    Predicate.isString(verified.plan.planId)
  ) {
    return verified.plan.planId
  }
  return "unissued"
}

const applyVerifiedPlan = (workspaceRoot: string, definition: WorkspaceDefinition) =>
  Effect.fn("PlanApplication.apply")(function* (verified: VerifiedPlan) {
    const issued = issuedVerifiedPlan(verified)
    if (issued === undefined) {
      return yield* asApplicationFailure(
        planIdOf(verified),
        "Verified plan was not issued by verification",
      )
    }
    const plan = issued.plan
    yield* requireMatchingProjectIdentity(plan, definition.projects)
    return yield* withExclusiveApplyLock(
      workspaceRoot,
      plan.planId,
      Effect.gen(function* () {
        // Recover leftover temps and partial commits before reading sources.
        yield* recoverUnfinishedApplication(workspaceRoot, plan.planId)
        // Rematerialize from the issued plan. Caller preview text is not used.
        const preview = yield* previewPlan(plan, workspaceRoot).pipe(
          Effect.mapError((error) =>
            error instanceof StalePlanError ? error : asApplicationFailure(plan.planId, error),
          ),
        )
        const staged: Array<StagedFile> = []
        const applied: Array<StagedFile> = []
        const createdDirectories: Array<string> = []
        let committed = false

        const cleanup = Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          for (const item of staged) {
            if (item.temporary !== undefined) {
              yield* fs.remove(item.temporary, { force: true }).pipe(Effect.ignore)
            }
          }
          if (!committed) {
            for (const directory of [...createdDirectories].reverse()) {
              yield* fs.remove(directory, { force: true }).pipe(Effect.ignore)
            }
          }
        })

        return yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path

          // Revalidate every fingerprint, including inputs not directly edited.
          yield* revalidatePlanSources(plan, workspaceRoot).pipe(
            Effect.mapError((error) =>
              error instanceof StalePlanError ? error : asApplicationFailure(plan.planId, error),
            ),
          )

          // Stage every resulting file before changing any target. Missing
          // parent directories are tracked so a failed transaction removes them.
          const stageExit = yield* Effect.gen(function* () {
            for (const file of preview.files) {
              const target = yield* checkExpectedState(plan, workspaceRoot, file)
              let temporary: string | undefined
              if (file.after.exists) {
                const parent = path.dirname(target)
                const missing: Array<string> = []
                let current = parent
                while (!(yield* fs.exists(current))) {
                  missing.push(current)
                  current = path.dirname(current)
                }
                for (const directory of missing.reverse()) {
                  // Non-recursive creation fails if another process wins the
                  // race, so cleanup never claims a directory it did not make.
                  yield* fs.makeDirectory(directory)
                  if (!createdDirectories.includes(directory)) createdDirectories.push(directory)
                }
                temporary = `${target}.safemods-${randomUUID()}.tmp`
                staged.push({ file, target, temporary })
                yield* fs.writeFileString(temporary, file.after.text ?? "", { flag: "wx" })
              } else {
                staged.push({ file, target })
              }
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof StalePlanError ? error : asApplicationFailure(plan.planId, error),
            ),
            Effect.result,
          )

          if (stageExit._tag === "Failure") return yield* stageExit.failure

          const journalPath = path.join(workspaceRoot, APPLY_JOURNAL_NAME)
          const journal: TransactionJournal = {
            planId: plan.planId,
            phase: "open",
            files: staged.map((item) => ({
              target: item.target,
              ...(item.temporary === undefined ? {} : { temporary: item.temporary }),
              before: item.file.before.exists
                ? { exists: true, text: item.file.before.text }
                : { exists: false },
            })),
            createdDirectories: [...createdDirectories],
          }
          yield* persistJournal(journalPath, journal)

          // Re-check each precondition immediately before its filesystem state
          // transition. This closes the create-target race after verification.
          const commitExit = yield* Effect.gen(function* () {
            for (const item of staged) {
              yield* checkExpectedState(plan, workspaceRoot, item.file)
              if (!item.file.after.exists) {
                yield* fs.remove(item.target)
                applied.push(item)
              } else {
                // Creates use no-clobber link. Existing files refuse to
                // rename-over live bytes that no longer match the plan.
                yield* item.file.before.exists
                  ? installExistingFile(plan, item.file, item.temporary!, item.target)
                  : fs.link(item.temporary!, item.target)
                applied.push(item)
                yield* fs.remove(item.temporary!, { force: true }).pipe(Effect.ignore)
              }
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof StalePlanError ? error : asApplicationFailure(plan.planId, error),
            ),
            Effect.result,
          )

          if (commitExit._tag === "Failure") {
            const rollbackExit = yield* Effect.gen(function* () {
              for (const item of [...applied].reverse()) {
                // Containment is enforced again for every inverse transition.
                const target = yield* safeTarget(
                  plan,
                  workspaceRoot,
                  item.file.projectId,
                  item.file.fileName,
                )
                if (!item.file.before.exists) {
                  yield* fs.remove(target, { force: true })
                } else {
                  const rollbackTemporary = `${target}.safemods-rollback-${randomUUID()}.tmp`
                  yield* Effect.gen(function* () {
                    yield* fs.writeFileString(rollbackTemporary, item.file.before.text ?? "", {
                      flag: "wx",
                    })
                    yield* fs.rename(rollbackTemporary, target)
                  }).pipe(
                    Effect.ensuring(
                      fs.remove(rollbackTemporary, { force: true }).pipe(Effect.ignore),
                    ),
                  )
                }
              }
            }).pipe(Effect.result)

            if (rollbackExit._tag === "Failure") {
              return yield* new ApplicationIndeterminate({
                planId: plan.planId,
                cause: commitExit.failure,
                rollbackCause: rollbackExit.failure,
              })
            }
            yield* fs.remove(journalPath, { force: true }).pipe(Effect.ignore)
            if (commitExit.failure instanceof StalePlanError) return yield* commitExit.failure
            return yield* asApplicationFailure(plan.planId, commitExit.failure.cause, true)
          }

          yield* persistJournal(journalPath, { ...journal, phase: "committed" })
          yield* fs
            .remove(journalPath, { force: true })
            .pipe(Effect.mapError((cause) => asApplicationFailure(plan.planId, cause)))
          committed = true
          return {
            planId: plan.planId,
            snapshotHash: plan.snapshotHash,
            outputs: preview.files.map((file) => ({
              projectId: file.projectId,
              fileName: file.fileName,
              hash: file.after.hash ?? "",
            })),
          }
        }).pipe(Effect.ensuring(cleanup))
      }),
    )
  })

/**
 * The service-only layer is intentionally exported from this module (but not
 * the public Node barrel) so failure-injection tests can provide a controlled
 * FileSystem implementation.
 */
export const applicationLayer = (
  workspaceRoot: string,
): Layer.Layer<PlanApplication, never, Workspace> =>
  Layer.effect(
    PlanApplication,
    Workspace.use((workspace) =>
      Effect.gen(function* () {
        const mutex = yield* Semaphore.make(1)
        return PlanApplication.of({
          apply: (verified) =>
            mutex.withPermit(applyVerifiedPlan(workspaceRoot, workspace.definition)(verified)),
        })
      }),
    ),
  )
