/** Canonical JSON and hashing for content-addressed plans. */
import { createHash } from "node:crypto"
import { Predicate } from "effect"
import type { Json, ProjectEvidence, SourceFingerprint, TransformationPlan } from "./Model.ts"

export const digest = (text: string): string => createHash("sha256").update(text).digest("hex")

const canonicalize = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

export const canonicalJson = (value: Json): string => JSON.stringify(canonicalize(value))

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
