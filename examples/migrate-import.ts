import { ConfiguredProject, Draft, Policy, Query, Recipe, WorkspaceSnapshot } from "teatime";
import { Effect } from "effect";
import { isStringLiteral } from "typescript/unstable/ast/is";

/**
 * Rewrites an import specifier while retaining its original quotes and the
 * comment inside the import clause. Run it against fixtures/stress.
 */
export default Recipe.define("migrate-legacy-import", {
  version: "1.0.0",
  policies: [Policy.matches({ min: 1, max: 1 }), Policy.noNewErrors(), Policy.idempotent()],
  run: () =>
    Effect.gen(function* () {
      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" });
      const snapshot = yield* WorkspaceSnapshot;
      const project = yield* snapshot.project(app);
      const legacyImports = yield* Query.imports(project).pipe(
        Query.filter(
          ({ value }) =>
            isStringLiteral(value.moduleSpecifier) && value.moduleSpecifier.text === "./legacy.js",
        ),
        Query.collect,
      );

      return yield* Draft.replaceEach(legacyImports, ({ value: declaration }) => {
        const specifier = declaration.moduleSpecifier;
        const quote = specifier.getText().startsWith("'") ? "'" : '"';
        return { node: specifier, text: `${quote}./replacement.js${quote}` };
      });
    }),
});
