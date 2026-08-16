import { Draft, ConfiguredProject, Policy, Query, Recipe, WorkspaceSnapshot } from "teaform";
import { Effect } from "effect";

const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" });

export default Recipe.define("bump-example-addend", {
  version: "1.0.0",
  policies: [Policy.matches({ min: 1, max: 1 }), Policy.noNewErrors(), Policy.idempotent()],
  run: () =>
    Effect.gen(function* () {
      const snapshot = yield* WorkspaceSnapshot;
      const project = yield* snapshot.project(app);
      const add = yield* project.symbolNamed("add", { within: "src/index.ts" });
      const calls = yield* Query.calls(project).pipe(
        Query.where(Query.resolvesTo(add, { location: (call) => call.expression })),
        Query.filter(({ value: call }) => call.arguments[0]?.getText() === "20"),
        Query.collect,
      );

      return yield* Draft.replaceEach(calls, ({ value: call }) => ({
        node: call.arguments[0]!,
        text: "21",
      }));
    }),
});
