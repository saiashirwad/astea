# safemods

Type-directed codemods for TypeScript 7 projects, built on Effect.
Still in very active development!

```sh
pnpm add -D safemods effect typescript@7
```

Recipes import `effect` and the TypeScript AST API directly, so both packages
should be installed alongside `safemods`.

## Sample Code

```ts
// rename-old-name.ts
import { Effect } from "effect"
import * as Draft from "safemods/Draft"
import * as Policy from "safemods/Policy"
import * as Recipe from "safemods/Recipe"
import { ConfiguredProject, WorkspaceSnapshot } from "safemods/Workspace"

const app = ConfiguredProject.make({
  id: "app",
  config: "tsconfig.json",
})

export default Recipe.define("rename-old-name", {
  version: "1.0.0",
  policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
  run: () =>
    Effect.gen(function* () {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(app)

      return yield* Draft.renameSymbolNamed(project, "oldName", "newName", {
        within: "src/library.ts",
      })
    }),
})
```

```ts
const matchingCalls = Query.calls(project).pipe(
  Query.where(Query.resolvesTo(target, { location: (call) => call.expression })),
  Query.withArgCount(1),
  Query.within("src/**/*.ts"),
  Query.collect,
)
```

```ts
Draft.imports.addNamed(project, "src/index.ts", {
  module: "effect",
  name: "Option",
})
Draft.replace(project, targetNode, "{ value: 1 }")
Draft.files.move(project, "src/old.ts", "src/new.ts")
```

```ts
Policy.matches({ min: 1 }) // primary-run match count within bounds
Policy.exactly(1)
Policy.atMostFiles(10)
Policy.noNewErrors() // the default: no newly introduced errors
Policy.fixesError(2345) // must resolve a specific diagnostic
Policy.allowErrors({ code: 2345, max: 2 }) // budget exceptions through the gate
Policy.diagnosticDiff("only-types", (diff) => diff.introduced.length === 0)
Policy.idempotent()
```

```ts
import { Effect, Layer } from "effect"
import * as Application from "safemods/Application"
import { applicationLayerNode, workspaceLayerNode } from "safemods/Node"
import * as Recipe from "safemods/Recipe"
import * as Verification from "safemods/Verification"
import { ConfiguredProject } from "safemods/Workspace"
import recipe from "./rename-old-name.ts"

const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
const workspaceLayer = workspaceLayerNode({ projects: [app] }, { cwd: "/path/to/project" })
const runtimeLayer = applicationLayerNode.pipe(Layer.provideMerge(workspaceLayer))

const program = Effect.gen(function* () {
  const plan = yield* Recipe.run(recipe, undefined)
  const preview = yield* Verification.of(plan)
  const verified = yield* Verification.verify(plan, recipe, undefined)
  const receipt = yield* Application.apply(verified)

  return { preview, receipt }
})

await Effect.runPromise(program.pipe(Effect.provide(runtimeLayer)))
```

More examples:

- [Rename a symbol](./examples/rename-symbol.ts)
- [Migrate an import](./examples/migrate-import.ts)
- [Replace a call argument](./examples/preview-add-call.ts)
- [Wrap API members behind a schema-validated input](./examples/semantic-api-migration.ts)
- [Stage changes through an overlay](./examples/overlay-aware-migration.ts)
- [Expose a recipe as an agent tool](./examples/agent-tool.ts)
- [Full API tour](./examples/declarative-api-tour.ts)
- [Architecture](./ARCHITECTURE.md)
- [Domain terminology](./CONTEXT.md)
