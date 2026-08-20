/** Recipe execution from input to a durable Plan. */
import { Effect, type FileSystem, type Path } from "effect"
import type { NativeCompilerError } from "../Compiler/Service.ts"
import { finalizeDraftEvidenceEffect, type DraftEvidenceConflict } from "../Draft/index.ts"
import { SYSTEM_VERSION } from "../generated/version.ts"
import { finalizePlan, type PlanBuildError, type TransformationPlan } from "../Plan/index.ts"
import {
  Workspace,
  WorkspaceSnapshot,
  type ProjectNotInSnapshot,
  type SnapshotExpired,
  type SnapshotTransition,
} from "../Workspace/index.ts"
import { fingerprintWorkspace } from "./Fingerprint.ts"
import { validateRecipeInput, type RecipeInputError } from "./Input.ts"
import type { Recipe } from "./Model.ts"

/** Toolchain identity recorded in each Plan. */
export const TOOLCHAIN = {
  systemVersion: SYSTEM_VERSION,
  typescriptVersion: "7.0.2",
  effectVersion: "4.0.0-rc.109",
} as const

/** Run a recipe through planning. This operation does not write project files. */
export const run = <Input, E, R>(
  recipe: Recipe<Input, E, R>,
  input: Input,
  transition: SnapshotTransition = {},
): Effect.Effect<
  TransformationPlan,
  | E
  | RecipeInputError
  | PlanBuildError
  | NativeCompilerError
  | ProjectNotInSnapshot
  | SnapshotExpired
  | DraftEvidenceConflict,
  Workspace | FileSystem.FileSystem | Path.Path | Exclude<R, WorkspaceSnapshot>
> =>
  Effect.gen(function* () {
    const validatedInput = yield* validateRecipeInput(recipe, input)
    const workspace = yield* Workspace
    return yield* workspace.withSnapshot(
      transition,
      Effect.gen(function* () {
        const snapshot = yield* WorkspaceSnapshot
        const draft = yield* recipe.run(validatedInput.value)
        const completeDraft = yield* finalizeDraftEvidenceEffect(draft)
        const sources = yield* fingerprintWorkspace(workspace.root, snapshot)

        const planInput = {
          recipe: {
            name: recipe.name,
            version: recipe.version,
            implementationHash: recipe.implementationHash,
            options: validatedInput.encoded,
          },
          toolchain: TOOLCHAIN,
          projects: snapshot.projects.map((configured) => ({
            id: configured.id,
            configFileName: configured.config,
          })),
          sources,
          edits: completeDraft.edits,
          evidence: completeDraft.evidence,
          policies: recipe.policies,
          measurements: { matches: completeDraft.matches },
        }
        const finalizedInput =
          completeDraft.fileOperations !== undefined
            ? { ...planInput, fileOperations: completeDraft.fileOperations }
            : planInput

        return yield* finalizePlan(finalizedInput)
      }),
    )
  })
