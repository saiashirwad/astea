/** Strict serialization and decoding for content-addressed plans. */
import { Effect, Schema } from "effect"
import { asJson, canonicalJson, digest, withoutPlanId } from "./Canonical.ts"
import { PlanDecodeError, type TransformationPlan } from "./TransformationPlan.ts"
import { strictPlanParseOptions, TransformationPlanSchema } from "./Structure.ts"
import { validateDecodedPlan } from "./Validate.ts"

export const serializePlan = (plan: TransformationPlan): string => canonicalJson(asJson(plan))

const decodeTransformationPlan = Schema.decodeUnknownEffect(
  TransformationPlanSchema,
  strictPlanParseOptions,
)

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- parse/validate I/O boundary; Schema is the parser.
const decodePlan = (decoded: unknown): Effect.Effect<TransformationPlan, PlanDecodeError> =>
  decodeTransformationPlan(decoded).pipe(
    Effect.mapError(() => new PlanDecodeError({ reason: "schema" })),
    Effect.map(
      // SAFETY: the schema validates every field; branded path types are runtime strings.
      (value) => value as TransformationPlan,
    ),
  )

const validateContentAddressedPlan = (
  plan: TransformationPlan,
): Effect.Effect<TransformationPlan, PlanDecodeError> =>
  Effect.gen(function* () {
    yield* validateDecodedPlan(plan).pipe(
      Effect.mapError(() => new PlanDecodeError({ reason: "schema" })),
    )
    if (digest(canonicalJson(withoutPlanId(plan))) !== plan.planId) {
      return yield* new PlanDecodeError({ reason: "hash" })
    }
    return plan
  })

/** Reject a plan that is not structurally exact, canonical, and content-addressed. */
export const validatePlan = (
  plan: TransformationPlan,
): Effect.Effect<TransformationPlan, PlanDecodeError> =>
  Effect.gen(function* () {
    yield* decodePlan(plan)
    return yield* validateContentAddressedPlan(plan)
  })

export const parsePlan = (text: string): Effect.Effect<TransformationPlan, PlanDecodeError> =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
    Effect.mapError(() => new PlanDecodeError({ reason: "json" })),
    Effect.flatMap(decodePlan),
    Effect.flatMap((plan) =>
      Effect.gen(function* () {
        if (text !== canonicalJson(asJson(plan)))
          return yield* new PlanDecodeError({ reason: "schema" })
        return yield* validateContentAddressedPlan(plan)
      }),
    ),
  )
