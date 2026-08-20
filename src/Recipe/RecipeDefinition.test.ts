import { describe, effect, expect } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as Draft from "../Draft/index.ts"
import { RecipeInputError } from "../Recipe/index.ts"
import * as Recipe from "../Recipe/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("recipe definition and input validation", () => {
  effect(
    "validates recipe inputs with Effect Schema",
    () =>
      withFixture((_, _app) =>
        Effect.gen(function* () {
          const schemaRecipe = Recipe.define("schema-recipe", {
            version: "1.0.0",
            schema: Schema.Struct({
              propertyName: Schema.NonEmptyString,
              multiplier: Schema.Finite,
            }),
            run: (input) =>
              Effect.sync(() => {
                expect(input.propertyName).toBe("validProp")
                expect(input.multiplier).toBe(42)
                return Draft.empty
              }),
          })

          // Valid input passes
          yield* Recipe.run(schemaRecipe, { propertyName: "validProp", multiplier: 42 })

          // Invalid input fails with RecipeInputError
          // SAFETY: the test intentionally provides invalid input to verify runtime schema validation.
          const failure = yield* Recipe.run(schemaRecipe, {
            propertyName: "",
            multiplier: 42,
          } as any).pipe(Effect.flip)
          expect(failure).toBeInstanceOf(RecipeInputError)
        }),
      ),
    60_000,
  )

  effect(
    "preserves a schema when composing with a schema-less recipe",
    () =>
      withFixture((_, _app) =>
        Effect.gen(function* () {
          const InputSchema = Schema.Struct({ value: Schema.NonEmptyString })
          const validated = Recipe.define("validated-child", {
            version: "1.0.0",
            schema: InputSchema,
            run: () => Effect.succeed(Draft.empty),
          })
          const schemaLess = Recipe.define<{ readonly value: string }>("schema-less-child", {
            version: "1.0.0",
            run: () => Effect.succeed(Draft.empty),
          })
          const composed = Recipe.pipe(schemaLess, validated)
          expect(composed.schema).toBe(InputSchema)
          const failure = yield* Recipe.run(composed, { value: "" }).pipe(Effect.flip)
          expect(failure).toBeInstanceOf(RecipeInputError)
        }),
      ),
    60_000,
  )
})
