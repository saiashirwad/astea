/** PROTOTYPE — provisional author-facing facade used only to test issue 12's contract. */
import { Effect } from "effect"
import type { TransformationPlan } from "./plan.ts"
import { finalizePlan, parsePlan, serializePlan } from "./plan.ts"
import {
  calls,
  collect,
  nodes,
  resolvesNodeToSymbol,
  resolvesToSymbol,
  whereBatched,
} from "./semantic-query.ts"
import {
  PlanApplication,
  previewPlan,
  verifyPreview,
  type VerifiedPlan,
} from "./verification.ts"
import {
  ConfiguredProject,
  Workspace,
  WorkspaceSnapshot,
  type SnapshotTransition,
} from "./workspace-snapshot.ts"

export interface TransformationRecipe<Input, E = never, R = never> {
  readonly identity: {
    readonly name: string
    readonly version: string
    readonly implementationHash: string
  }
  readonly run: (input: Input) => Effect.Effect<TransformationPlan, E, R | WorkspaceSnapshot>
}

const defineRecipe = <Input, E, R>(
  definition: TransformationRecipe<Input, E, R>,
): TransformationRecipe<Input, E, R> => Object.freeze(definition)

const runRecipe = <Input, E, R>(
  recipe: TransformationRecipe<Input, E, R>,
  input: Input,
  transition: SnapshotTransition = {},
) => Workspace.use((workspace) => workspace.withSnapshot(transition, recipe.run(input)))

export const Recipe = {
  define: defineRecipe,
  run: runRecipe,
}

export const Query = {
  nodes,
  calls,
  whereBatched,
  resolvesToSymbol,
  resolvesNodeToSymbol,
  collect,
}

export const Plan = {
  finalize: finalizePlan,
  serialize: serializePlan,
  parse: parsePlan,
}

export const Verification = {
  preview: previewPlan,
  evaluatePrototypeObservation: verifyPreview,
}

export const Application = {
  apply: (verified: VerifiedPlan) => PlanApplication.use((application) => application.apply(verified)),
}

export { ConfiguredProject, Workspace, WorkspaceSnapshot }
export type { TransformationPlan, VerifiedPlan }
