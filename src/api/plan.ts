/**
 * Candidate public API — the durable Transformation Plan.
 *
 * A finalized Plan is canonical, content-addressed JSON: it crosses process
 * boundaries, is reviewable and resumable, and carries no live capability.
 * Authors never finalize plans by hand — `Recipe.run` owns finalization.
 * This surface is the codec plus the durable types.
 */
import { parsePlan, serializePlan } from "../prototype/plan.ts"

export {
  PlanBuildError,
  PlanDecodeError,
} from "../prototype/plan.ts"

export type {
  EvidenceRecord,
  Json,
  PlanMeasurements,
  PlanPolicies,
  PlannedTextEdit,
  ProjectEvidence,
  SourceFingerprint,
  TransformationPlan,
} from "../prototype/plan.ts"

import type { PlannedTextEdit } from "../prototype/plan.ts"

/** The canonical durable change primitive: a guarded, half-open source range replacement. */
export type TextEdit = PlannedTextEdit

export const Plan = {
  serialize: serializePlan,
  parse: parsePlan,
}
