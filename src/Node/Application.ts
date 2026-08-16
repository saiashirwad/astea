import { randomUUID } from "node:crypto"
import { Effect, FileSystem, Layer, Path } from "effect"
import {
  ApplicationFailure,
  ApplicationIndeterminate,
  PlanApplication,
} from "../Application/Model.ts"
import { textHash } from "../Edit/index.ts"
import type { TransformationPlan } from "../Plan/index.ts"
import { StalePlanError, type FilePreview, type VerifiedPlan } from "../Verification/Engine.ts"
import { Workspace } from "../Workspace/index.ts"
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
): Layer.Layer<PlanApplication | FileSystem.FileSystem | Path.Path> =>
  Layer.merge(applicationLayer(workspaceRoot), nodeLayer)

const absoluteFileName = (
  plan: TransformationPlan,
  workspaceRoot: string,
  projectId: string,
  fileName: string,
): Effect.Effect<string, never, Path.Path> => Effect.gen(function*() {
  const path = yield* Path.Path
  const project = plan.projects.find((candidate) => candidate.id === projectId)
  if (project === undefined) return yield* Effect.die(new Error(`Unknown project ID: ${projectId}`))
  return path.resolve(workspaceRoot, path.dirname(project.configFileName), fileName)
})

const applicationLayer = (workspaceRoot: string): Layer.Layer<PlanApplication> => Layer.succeed(
  PlanApplication,
  PlanApplication.of({
    apply: Effect.fn("PlanApplication.apply")(function*(verified: VerifiedPlan) {
      const { plan, preview } = verified
      const staged: Array<{ readonly target: string; readonly temporary: string; readonly isDelete?: boolean }> = []
      const applied: Array<FilePreview> = []

      for (const source of plan.sources) {
        const target = yield* absoluteFileName(plan, workspaceRoot, source.projectId, source.fileName)
        const current = yield* FileSystem.FileSystem.use((fs) => fs.readFileString(target)).pipe(Effect.mapError(() => new StalePlanError({ planId: plan.planId, projectId: source.projectId, fileName: source.fileName })))
        if (textHash(current) !== source.hash) return yield* new StalePlanError({ planId: plan.planId, projectId: source.projectId, fileName: source.fileName })
      }

      for (const file of preview.files) {
        const target = yield* absoluteFileName(plan, workspaceRoot, file.projectId, file.fileName)
        if (file.beforeText === "") {
          const path = yield* Path.Path
          const fs = yield* FileSystem.FileSystem
          yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(Effect.mapError((cause) => new ApplicationFailure({ planId: plan.planId, cause, rolledBack: false })))
          const temporary = `${target}.safemods-${randomUUID()}.tmp`
          yield* fs.writeFileString(temporary, file.afterText).pipe(Effect.mapError((cause) => new ApplicationFailure({ planId: plan.planId, cause, rolledBack: true })))
          staged.push({ target, temporary, isDelete: false })
        } else if (file.afterText === "") {
          staged.push({ target, temporary: "", isDelete: true })
        } else {
          const current = yield* FileSystem.FileSystem.use((fs) => fs.readFileString(target)).pipe(Effect.mapError(() => new StalePlanError({ planId: plan.planId, projectId: file.projectId, fileName: file.fileName })))
          if (textHash(current) !== file.beforeHash) return yield* new StalePlanError({ planId: plan.planId, projectId: file.projectId, fileName: file.fileName })
          const temporary = `${target}.safemods-${randomUUID()}.tmp`
          yield* FileSystem.FileSystem.use((fs) => fs.writeFileString(temporary, file.afterText)).pipe(Effect.mapError((cause) => new ApplicationFailure({ planId: plan.planId, cause, rolledBack: true })))
          staged.push({ target, temporary, isDelete: false })
        }
      }

      const applyExit = yield* Effect.gen(function*() {
        for (let index = 0; index < staged.length; index++) {
          const item = staged[index]!
          if (item.isDelete) yield* FileSystem.FileSystem.use((fs) => fs.remove(item.target, { force: true }))
          else yield* FileSystem.FileSystem.use((fs) => fs.rename(item.temporary, item.target))
          applied.push(preview.files[index]!)
        }
      }).pipe(Effect.exit)

      if (applyExit._tag === "Failure") {
        const cause = applyExit.cause
        const rollback = yield* Effect.gen(function*() {
          for (const file of applied) {
            const target = yield* absoluteFileName(plan, workspaceRoot, file.projectId, file.fileName)
            yield* FileSystem.FileSystem.use((fs) => fs.writeFileString(target, file.beforeText))
          }
          for (const item of staged) yield* FileSystem.FileSystem.use((fs) => fs.remove(item.temporary, { force: true }))
        }).pipe(Effect.exit)
        if (rollback._tag === "Failure") return yield* new ApplicationIndeterminate({ planId: plan.planId, cause, rollbackCause: rollback.cause })
        return yield* new ApplicationFailure({ planId: plan.planId, cause, rolledBack: true })
      }

      return {
        planId: plan.planId,
        snapshotHash: plan.snapshotHash,
        outputs: preview.files.map((file) => ({ projectId: file.projectId, fileName: file.fileName, hash: file.afterHash })),
      }
    }),
  }),
)
