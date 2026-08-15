/**
 * Second example recipe against the candidate public API: rewrite an import
 * source specifier, preserving the original quote style and all surrounding
 * trivia. Demonstrates that the surface is not overfit to call-site rewrites.
 */
import { Effect } from "effect"
import { isStringLiteral } from "typescript/unstable/ast/is"
import { Draft } from "./draft.ts"
import { Policy } from "./policy.ts"
import { Query } from "./query.ts"
import { Recipe } from "./recipe.ts"
import { type ConfiguredProject, WorkspaceSnapshot } from "./workspace.ts"

export interface MigrateImportSourceInput {
  readonly project: ConfiguredProject
  readonly from: string
  readonly to: string
}

export const migrateImportSource = Recipe.define("migrate-import-source", {
  version: "1.0.0",
  policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
  run: (input: MigrateImportSourceInput) =>
    Effect.gen(function*() {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(input.project)

      const declarations = yield* Query.imports(project).pipe(
        Query.filter(({ value }) =>
          isStringLiteral(value.moduleSpecifier) && value.moduleSpecifier.text === input.from
        ),
        Query.collect,
      )

      return yield* Draft.replaceEach(declarations, ({ value }) => {
        const specifier = value.moduleSpecifier
        const quote = specifier.getText().startsWith("'") ? "'" : "\""
        return { node: specifier, text: `${quote}${input.to}${quote}` }
      })
    }),
})
