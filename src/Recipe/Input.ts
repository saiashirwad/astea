/** Recipe input validation and durable encoding. */
import { Data, Effect, Schema } from "effect"
import type { Json } from "../Plan/index.ts"
import type { Recipe } from "./Model.ts"

export class RecipeInputError extends Data.TaggedError("RecipeInputError")<{
  readonly recipe: string
  readonly cause: unknown
}> {}

export interface ValidatedRecipeInput<Input> {
  readonly value: Input
  readonly encoded: Json
}

/** Validate recipe input and encode the exact durable plan options. */
export const validateRecipeInput = <Input, E, R>(
  recipe: Recipe<Input, E, R>,
  input: Input,
): Effect.Effect<ValidatedRecipeInput<Input>, RecipeInputError> => {
  if (recipe.schema === undefined) return Effect.succeed({ value: input, encoded: input ?? null })

  const schema = recipe.schema
  return Effect.gen(function* () {
    // SAFETY: Recipe schemas are pure and fail only with SchemaError.
    const decode = Schema.decodeUnknownEffect(schema) as (
      value: Input,
    ) => Effect.Effect<Input, Schema.SchemaError>
    const value = yield* decode(input)
    // SAFETY: Recipe schemas encode to the JSON value stored in the Plan.
    const encode = Schema.encodeUnknownEffect(schema) as (
      value: Input,
    ) => Effect.Effect<Json, Schema.SchemaError>
    const encoded = yield* encode(value)
    return { value, encoded }
  }).pipe(Effect.mapError((cause) => new RecipeInputError({ recipe: recipe.name, cause })))
}
