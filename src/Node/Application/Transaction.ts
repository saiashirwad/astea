import { randomUUID } from "node:crypto"
import { Effect, FileSystem, Path, Predicate } from "effect"
import { ApplicationIndeterminate } from "../../Application/Model.ts"
import type { TransformationPlan } from "../../Plan/index.ts"
import { StalePlanError } from "../../Verification/Errors.ts"
import { previewPlan } from "../../Verification/Preview.ts"
import {
  requireMatchingProjectIdentity,
  revalidatePlanSources,
} from "../../Verification/SourceRevalidation.ts"
import { issuedVerifiedPlan, type VerifiedPlan } from "../../Verification/VerifiedPlan.ts"
import type { WorkspaceDefinition } from "../../Workspace/index.ts"
import { asApplicationFailure } from "./Failure.ts"
import {
  APPLY_JOURNAL_NAME,
  persistJournal,
  type JournalBeforeState,
  type JournalEntry,
  type TransactionJournal,
} from "./Journal.ts"
import { withExclusiveApplyLock } from "./Lock.ts"
import { safeTarget } from "./PathSafety.ts"
import { recoverUnfinishedApplication } from "./Recovery.ts"
import {
  checkExpectedState,
  installExistingFile,
  stagePreviewFiles,
  type StagedFile,
} from "./Stage.ts"

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

const journalEntry = (item: StagedFile): JournalEntry => {
  const before: JournalBeforeState = item.file.before.exists
    ? { exists: true, text: item.file.before.text }
    : { exists: false }
  return item.temporary === undefined
    ? { target: item.target, before }
    : { target: item.target, temporary: item.temporary, before }
}

const rollbackAppliedFiles = (
  plan: TransformationPlan,
  workspaceRoot: string,
  applied: ReadonlyArray<StagedFile>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    for (const item of [...applied].reverse()) {
      // Containment is enforced again for every inverse transition.
      const target = yield* safeTarget(plan, workspaceRoot, item.file.projectId, item.file.fileName)
      if (!item.file.before.exists) {
        yield* fs.remove(target, { force: true })
      } else {
        const rollbackTemporary = `${target}.safemods-rollback-${randomUUID()}.tmp`
        yield* Effect.gen(function* () {
          yield* fs.writeFileString(rollbackTemporary, item.file.before.text ?? "", {
            flag: "wx",
          })
          yield* fs.rename(rollbackTemporary, target)
        }).pipe(Effect.ensuring(fs.remove(rollbackTemporary, { force: true }).pipe(Effect.ignore)))
      }
    }
  })

export const applyVerifiedPlan = (workspaceRoot: string, definition: WorkspaceDefinition) =>
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
          const stageExit = yield* stagePreviewFiles(
            plan,
            workspaceRoot,
            preview.files,
            staged,
            createdDirectories,
          ).pipe(Effect.result)

          if (stageExit._tag === "Failure") return yield* stageExit.failure

          const journalPath = path.join(workspaceRoot, APPLY_JOURNAL_NAME)
          const journal: TransactionJournal = {
            planId: plan.planId,
            phase: "open",
            files: staged.map(journalEntry),
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
            const rollbackExit = yield* rollbackAppliedFiles(plan, workspaceRoot, applied).pipe(
              Effect.result,
            )

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
