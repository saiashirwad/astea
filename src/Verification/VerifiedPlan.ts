/** Process-local capability that grants application authority. */
import { Predicate } from "effect"
import type { TransformationPlan } from "../Plan/index.ts"
import type { DiagnosticDiff } from "../Policy/index.ts"
import type { PlanPreview } from "./Preview.ts"
import type { VerificationReceipt } from "./VerificationReceipt.ts"

// Process-local token. Symbol.for would be forgeable across the isolate.
const VerifiedPlanTypeId: unique symbol = Symbol("@safemods/internal/VerifiedPlan")

export interface VerifiedPlan {
  readonly [VerifiedPlanTypeId]: typeof VerifiedPlanTypeId
  readonly plan: TransformationPlan
  readonly preview: PlanPreview
  readonly receipt: VerificationReceipt
}

interface IssuedVerifiedPlan {
  readonly plan: TransformationPlan
  readonly preview: PlanPreview
  readonly receipt: VerificationReceipt
}

const issuedVerifiedPlans = new WeakMap<VerifiedPlan, IssuedVerifiedPlan>()

const freezeDeep = <A>(value: A): A => {
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item)
    return Object.freeze(value)
  }
  if (value !== null && Predicate.isObject(value)) {
    for (const item of Object.values(value)) freezeDeep(item)
    return Object.freeze(value)
  }
  return value
}

export const issueVerifiedPlan = (
  plan: TransformationPlan,
  preview: PlanPreview,
  receipt: VerificationReceipt,
  diagnosticDiff: DiagnosticDiff,
): VerifiedPlan & { readonly diagnosticDiff: DiagnosticDiff } => {
  const issuedPlan = freezeDeep(structuredClone(plan))
  const issuedPreview = freezeDeep(structuredClone(preview))
  const issuedReceipt = freezeDeep(structuredClone(receipt))
  const verified: VerifiedPlan & { readonly diagnosticDiff: DiagnosticDiff } = {
    [VerifiedPlanTypeId]: VerifiedPlanTypeId,
    plan: issuedPlan,
    preview: issuedPreview,
    receipt: issuedReceipt,
    diagnosticDiff: freezeDeep(structuredClone(diagnosticDiff)),
  }
  Object.freeze(verified)
  issuedVerifiedPlans.set(verified, {
    plan: issuedPlan,
    preview: issuedPreview,
    receipt: issuedReceipt,
  })
  return verified
}

/** Contents of a VerifiedPlan minted by successful verification, if any. */
export const issuedVerifiedPlan = (verified: VerifiedPlan): IssuedVerifiedPlan | undefined =>
  issuedVerifiedPlans.get(verified)
