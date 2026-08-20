import { Effect, Schema } from "effect"
import { isObjectLiteralExpression } from "typescript/unstable/ast/is"
import * as Draft from "safemods/Draft"
import * as Policy from "safemods/Policy"
import * as Query from "safemods/Query"
import * as Recipe from "safemods/Recipe"
import { ConfiguredProject, WorkspaceSnapshot } from "safemods/Workspace"

const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })

const OptionsSchema = Schema.Struct({
  wrapper: Schema.NonEmptyString,
  member: Schema.NonEmptyString,
})

export default Recipe.define("wrap-target-arguments", {
  version: "1.0.0",
  schema: OptionsSchema,
  policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
  run: Effect.fnUntraced(function* ({ member, wrapper }) {
    const snapshot = yield* WorkspaceSnapshot
    const project = yield* snapshot.project(app)
    const target = yield* project.symbolNamed("target", { within: "src/library.ts" })
    const calls = yield* Query.calls(project).pipe(
      Query.where(Query.resolvesTo(target, { location: (call) => call.expression })),
      Query.within("src"),
      Query.withArgCount({ min: 1, max: 1 }),
      Query.filter(({ value: call }) => !isObjectLiteralExpression(call.arguments[0]!)),
      Query.collect,
    )

    return yield* Draft.replaceEach(calls, ({ value: call }) => {
      const argument = call.arguments[0]!
      return {
        node: argument,
        text: `${wrapper}({ ${member}: ${argument.getText(call.getSourceFile())} })`,
      }
    })
  }),
})
