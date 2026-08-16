/**
 * Candidate public API — the durable Transformation Plan.
 *
 * A finalized Plan is canonical, content-addressed JSON: it crosses process
 * boundaries, is reviewable and resumable, and carries no live capability.
 * Authors never finalize plans by hand — `Recipe.run` owns finalization.
 * This surface is the codec plus the durable types.
 */
import { parsePlan, serializePlan } from "../Plan/index.ts"

export {
  PlanBuildError,
  PlanDecodeError,
} from "../Plan/index.ts"

export type {
  EvidenceRecord,
  Json,
  PlanMeasurements,
  PlanPolicies,
  PlannedFileOperation,
  PlannedTextEdit,
  ProjectEvidence,
  SourceFingerprint,
  TransformationPlan,
} from "../Plan/index.ts"

import type { PlannedTextEdit } from "../Plan/index.ts"

/** The canonical durable change primitive: a guarded, half-open source range replacement. */
export type TextEdit = PlannedTextEdit

export const Plan = {
  serialize: serializePlan,
  parse: parsePlan,
}
