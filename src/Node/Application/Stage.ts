import { randomUUID } from "node:crypto"
import { Effect, FileSystem, Path } from "effect"
import type { TransformationPlan } from "../../Plan/index.ts"
import { textHash } from "../../Edit/index.ts"
import { StalePlanError } from "../../Verification/Errors.ts"
import type { FilePreview } from "../../Verification/Preview.ts"
import { asApplicationFailure } from "./Failure.ts"
import { safeTarget } from "./PathSafety.ts"

export interface StagedFile {
  readonly file: FilePreview
  readonly target: string
  readonly temporary?: string | undefined
}

export const checkExpectedState = (
  plan: TransformationPlan,
  workspaceRoot: string,
  file: FilePreview,
): Effect.Effect<
  string,
  StalePlanError | ReturnType<typeof asApplicationFailure>,
  FileSystem.FileSystem | Path.Path
> =>
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
export const installExistingFile = (
  plan: TransformationPlan,
  file: FilePreview,
  temporary: string,
  target: string,
): Effect.Effect<
  void,
  StalePlanError | ReturnType<typeof asApplicationFailure>,
  FileSystem.FileSystem
> =>
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

export const stagePreviewFiles = (
  plan: TransformationPlan,
  workspaceRoot: string,
  files: ReadonlyArray<FilePreview>,
  staged: Array<StagedFile>,
  createdDirectories: Array<string>,
): Effect.Effect<
  void,
  StalePlanError | ReturnType<typeof asApplicationFailure>,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    for (const file of files) {
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
  )
