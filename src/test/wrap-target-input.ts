/**
 * Example Transformation Recipe written against the candidate public API:
 * wrap the argument of every call to the canonical `target` symbol in an
 * object — through import aliases and re-exports, preserving trivia.
 *
 * Compare `src/prototype/wrap-target-recipe.ts`: no file reads, no hashes,
 * no evidence ID strings, no toolchain literals, no fingerprint loops. The
 * body reads as intent.
 */
import { Effect } from "effect";
import { isObjectLiteralExpression } from "typescript/unstable/ast/is";
import * as Draft from "../Draft/index.ts";
import * as Policy from "../Policy/index.ts";
import * as Query from "../Query/index.ts";
import * as Recipe from "../Recipe/index.ts";
import { type ConfiguredProject, WorkspaceSnapshot } from "../Workspace/index.ts";

export interface WrapTargetInput {
  readonly project: ConfiguredProject;
  /** Project-relative file declaring the target symbol. */
  readonly declarationFile: string;
  /** Property name used to wrap each argument. */
  readonly property: string;
}

export const wrapTargetInput = Recipe.define("wrap-target-input", {
  version: "1.0.0",
  policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
  run: (input: WrapTargetInput) =>
    Effect.gen(function* () {
      const snapshot = yield* WorkspaceSnapshot;
      const project = yield* snapshot.project(input.project);

      const target = yield* project.symbolNamed("target", { within: input.declarationFile });

      const matches = yield* Query.calls(project).pipe(
        Query.where(Query.resolvesTo(target, { location: (call) => call.expression })),
        Query.filter(
          ({ value: call }) =>
            call.arguments.length === 1 && !isObjectLiteralExpression(call.arguments[0]!),
        ),
        Query.collect,
      );

      return yield* Draft.replaceEach(matches, ({ value: call }) => {
        const argument = call.arguments[0]!;
        return { node: argument, text: `{ ${input.property}: ${argument.getText()} }` };
      });
    }),
});
