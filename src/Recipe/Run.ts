/** Recipe execution from input to a durable Plan. */
import { Effect } from "effect"
import type { NativeCompilerError } from "../Compiler/Service.ts"
import type { DraftEvidenceConflict } from "../Draft/index.ts"
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
  Workspace | Exclude<R, WorkspaceSnapshot>
> =>
  Effect.gen(function* () {
    const validatedInput = yield* validateRecipeInput(recipe, input)
    const workspace = yield* Workspace
    return yield* workspace.withSnapshot(
      transition,
      Effect.gen(function* () {
        const snapshot = yield* WorkspaceSnapshot
        const draft = yield* recipe.run(validatedInput.value)
        const sources = yield* fingerprintWorkspace(workspace.root, snapshot)
        const declaredEvidence = new Set(draft.evidence.map((item) => item.id))
        const referencedEvidence = new Set([
          ...draft.edits.flatMap((edit) => edit.evidenceIds),
          ...(draft.fileOperations ?? []).flatMap((operation) => operation.evidenceIds ?? []),
        ])
        const evidence = [
          ...draft.evidence,
          ...[...referencedEvidence]
            .filter((id) => !declaredEvidence.has(id))
            .map((id) => ({ id, kind: "draft-operation", facts: {} })),
        ]

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
          edits: draft.edits,
          evidence,
          policies: recipe.policies,
          measurements: { matches: draft.matches },
        }
        const finalizedInput =
          draft.fileOperations !== undefined
            ? { ...planInput, fileOperations: draft.fileOperations }
            : planInput

        return yield* finalizePlan(finalizedInput)
      }),
    )
  })
