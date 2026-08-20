import { Effect, FileSystem, Path } from "effect"
import { asApplicationFailure } from "./Failure.ts"

const APPLY_LOCK_NAME = ".safemods-apply.lock"

const processExists = (pid: number): boolean => {
  try {
    // Signal 0 does not kill; it reports whether the lock owner is alive.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const acquireApplyLock = (
  workspaceRoot: string,
  planId: string,
): Effect.Effect<
  string,
  ReturnType<typeof asApplicationFailure>,
  FileSystem.FileSystem | Path.Path
> =>
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

export const withExclusiveApplyLock = <A, E, R>(
  workspaceRoot: string,
  planId: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | ReturnType<typeof asApplicationFailure>,
  R | FileSystem.FileSystem | Path.Path
> =>
  Effect.acquireUseRelease(
    acquireApplyLock(workspaceRoot, planId),
    () => body,
    (lockPath) =>
      FileSystem.FileSystem.use((fs) => fs.remove(lockPath, { force: true })).pipe(Effect.ignore),
  )
