/** Canonical JSON and hashing for content-addressed plans. */
import { createHash } from "node:crypto"
import { canonicalJson } from "../Evidence/Canonical.ts"
import type { Json, ProjectEvidence, SourceFingerprint, TransformationPlan } from "./Model.ts"

export const digest = (text: string): string => createHash("sha256").update(text).digest("hex")

export { canonicalJson }

export const asJson = (
  value:
    | Json
    | TransformationPlan
    | {
        readonly projects: ReadonlyArray<ProjectEvidence>
        readonly sources: ReadonlyArray<SourceFingerprint>
      },
): Json =>
  // SAFETY: value is guaranteed to be JSON serializable
  value as Json

export const withoutPlanId = (plan: TransformationPlan): Json => {
  const { planId: _, ...payload } = plan
  return asJson(payload)
}
