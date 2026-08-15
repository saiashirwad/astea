import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import type { CallExpression } from "typescript/unstable/ast"
import { describe, expect, it } from "vitest"
import { buildImportMigrationPlan } from "./stress-recipes.ts"
import {
  ConfiguredProject,
  Query,
  Recipe,
  WorkspaceSnapshot,
  type TransformationRecipe,
} from "./public-api-probe.ts"
import type { Query as QueryType } from "./semantic-query.ts"
import { layer } from "./workspace-snapshot.ts"

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value
type QueryNode<Value> = Value extends QueryType<infer Node, infer _E, infer _R> ? Node : never

const fixtureRoot = fileURLToPath(new URL("../../fixtures/stress/", import.meta.url))
const configured = ConfiguredProject.make(Path.join(fixtureRoot, "tsconfig.json"))

interface Input {
  readonly project: typeof configured
  readonly projectRoot: string
  readonly from: string
  readonly to: string
}

const recipe = Recipe.define({
  identity: {
    name: "probe-import-migration",
    version: "1.0.0",
    implementationHash: "probe",
  },
  run: (input: Input) => Effect.gen(function*() {
    const snapshot = yield* WorkspaceSnapshot
    const project = yield* snapshot.project(input.project)
    return (yield* buildImportMigrationPlan(project, input.projectRoot, {
      from: input.from,
      to: input.to,
      expectedMatches: 1,
    })).plan
  }),
})

type _InputInference = Assert<Equal<Parameters<typeof recipe.run>[0], Input>>
type _RecipeAssignable = Assert<typeof recipe extends TransformationRecipe<Input, infer _E, infer _R> ? true : false>
type _CallInference = Assert<Equal<QueryNode<ReturnType<typeof Query.calls>>, CallExpression>>

describe("provisional public API contract", () => {
  it("runs one typed recipe through the same facade available to agents and humans", async () => {
    const plan = await Effect.runPromise(Recipe.run(recipe, {
      project: configured,
      projectRoot: fixtureRoot,
      from: "./legacy.js",
      to: "./replacement.js",
    }).pipe(Effect.provide(layer({ projects: [configured] }, { cwd: fixtureRoot }))))

    expect(plan.recipe.name).toBe("migrate-import-source")
    expect(plan.edits).toHaveLength(1)
    expect(plan.policies.idempotence).toBe("required")
  })
})
