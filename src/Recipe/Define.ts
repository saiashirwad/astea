/** Recipe construction. */
import { createHash } from "node:crypto"
import { Effect, type Schema } from "effect"
import type { PlanPolicies } from "../Plan/index.ts"
import * as Policy from "../Policy/index.ts"
import type { VerificationRule } from "../Policy/index.ts"
import type {
  Recipe,
  RecipeDefinition,
  ScanningRecipe,
  ScanningRecipeDefinition,
} from "./Recipe.ts"

/** Construct a recipe from durable policies and runtime rules. */
export const fromCompiled = <Input, E, R>(
  name: string,
  version: string,
  compiled: { readonly policy: PlanPolicies; readonly rules: ReadonlyArray<VerificationRule> },
  run: Recipe<Input, E, R>["run"],
  options: {
    readonly schema?: Schema.Schema<Input> | undefined
    readonly implementationHash?: string | undefined
  } = {},
): Recipe<Input, E, R> =>
  Object.freeze({
    name,
    version,
    schema: options.schema,
    implementationHash:
      options.implementationHash ?? createHash("sha256").update(`${name}@${version}`).digest("hex"),
    policies: compiled.policy,
    rules: compiled.rules,
    run,
  })

export const define = <Input = undefined, E = never, R = never>(
  name: string,
  definition: RecipeDefinition<Input, E, R>,
): Recipe<Input, E, R> => {
  const compiled = Policy.all(definition.policies ?? [])
  return fromCompiled(name, definition.version, compiled, definition.run, {
    schema: definition.schema,
    implementationHash: definition.implementationHash,
  })
}

/** Define a two-phase recipe with one shared scan result. */
export const scanning = <Acc, Input = undefined, E1 = never, R1 = never, E2 = never, R2 = never>(
  name: string,
  definition: ScanningRecipeDefinition<Acc, Input, E1, R1, E2, R2>,
): ScanningRecipe<Acc, Input, E1 | E2, R1 | R2> => {
  const scan = definition.scan
  const runWithAcc = definition.run
  const compiled = Policy.all(definition.policies ?? [])
  const recipe = fromCompiled(
    name,
    definition.version,
    compiled,
    (input: Input) =>
      Effect.gen(function* () {
        const acc = yield* scan(input)
        return yield* runWithAcc(acc, input)
      }),
    {
      schema: definition.schema,
      implementationHash: definition.implementationHash,
    },
  )
  return Object.freeze({ ...recipe, scan })
}
