/**
 * Second example recipe against the candidate public API: rewrite an import
 * source specifier, preserving the original quote style and all surrounding
 * trivia. Demonstrates that the surface is not overfit to call-site rewrites.
 */
import { Effect } from "effect"
import { isStringLiteral } from "typescript/unstable/ast/is"
import * as Draft from "../Draft/index.ts"
import * as Policy from "../Policy/index.ts"
import * as Query from "../Query/index.ts"
import * as Recipe from "../Recipe/index.ts"
import { type ConfiguredProject, WorkspaceSnapshot } from "../Workspace/index.ts"

export interface MigrateImportSourceInput {
  readonly project: ConfiguredProject
  readonly from: string
  readonly to: string
}

export const migrateImportSource = Recipe.define("migrate-import-source", {
  version: "1.0.0",
  policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
  run: (input: MigrateImportSourceInput) =>
    Effect.gen(function* () {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(input.project)

      const declarations = yield* Query.imports(project).pipe(
        Query.filter(
          ({ value }) =>
            isStringLiteral(value.moduleSpecifier) && value.moduleSpecifier.text === input.from,
        ),
        Query.collect,
      )

      return yield* Draft.replaceEach(declarations, ({ value }) => {
        const specifier = value.moduleSpecifier
        const quote = specifier.getText().startsWith("'") ? "'" : '"'
        return { node: specifier, text: `${quote}${input.to}${quote}` }
      })
    }),
})
