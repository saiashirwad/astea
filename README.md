# Teatime

Effect-native TypeScript 7 transformations for reliable codemods.

Teatime lets you select code by TypeScript meaning, propose minimal edits, inspect and verify the result, and write it only with explicit authority.

```text
Workspace snapshot → Query → Draft → Transformation plan → Preview → Verification → Application
```

Planning, previewing, and verification are read-only. `Application.apply` is the only API that writes to disk, and it accepts a `VerifiedPlan` rather than an unverified plan.

## Run the tour

The executable tour copies a fixture to a temporary directory, runs a recipe through the full pipeline, and removes the temporary directory afterward.

```sh
pnpm install
pnpm exec tsx examples/declarative-api-tour.ts
```

It demonstrates semantic matching, minimal edits, diagnostic checks, idempotence, and explicit application.

## Write a recipe

A recipe reads a `WorkspaceSnapshot`, queries a configured project, and returns a `Draft`. Running it produces a durable transformation plan.

```ts
import { Effect } from "effect"
import { isObjectLiteralExpression } from "typescript/unstable/ast/is"
import {
  ConfiguredProject,
  Draft,
  Policy,
  Query,
  Recipe,
  WorkspaceSnapshot,
} from "teatime"

const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })

export default Recipe.define("wrap-target-input", {
  version: "1.0.0",
  policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
  run: () =>
    Effect.gen(function*() {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(app)
      const target = yield* project.symbolNamed("target", { within: "src/library.ts" })
      const calls = yield* Query.calls(project).pipe(
        Query.where(Query.resolvesTo(target, { location: (call) => call.expression })),
        Query.filter(({ value }) =>
          value.arguments.length === 1 && !isObjectLiteralExpression(value.arguments[0]!),
        ),
        Query.collect,
      )

      return yield* Draft.replaceEach(calls, ({ value: call }) => {
        const argument = call.arguments[0]!
        return { node: argument, text: `{ value: ${argument.getText()} }` }
      })
    }),
})
```

The recipe declares its expected matches and safety checks as policies. Its draft contains guarded, focused edits rather than a reprinted file.

## Preview, verify, then apply

Use the CLI to run a recipe against a target workspace. Preview is the default; `--apply` includes verification before it writes.

```sh
pnpm exec tsx bin/teatime.ts run ./recipe.ts --cwd ./my-project --preview
pnpm exec tsx bin/teatime.ts run ./recipe.ts --cwd ./my-project --verify
pnpm exec tsx bin/teatime.ts run ./recipe.ts --cwd ./my-project --apply
```

Useful options:

- `--input '<json>'` supplies recipe input.
- `--cwd <path>` selects the target workspace.
- `--no-color` disables ANSI output.
- `--help` shows command help.

A recipe module may export a `Recipe` as its default export, as `recipe`, or as another named export. `teatime tool ./recipe.ts` exposes an agent-facing tool description with the same schema, preview, verification, and optional application flow.

## Core capabilities

- Semantic queries, type inspection, symbol references, and project-wide renames.
- In-memory snapshot overlays for multi-stage transformations.
- Guarded text edits that preserve source bytes outside explicit edit ranges.
- Declarative recipes with Effect Schema validation and policies.
- Diagnostic diffs, no-new-error checks, and idempotence verification.
- File creation, deletion, and moves with relative-import rewriting.
- Draft helpers for imports, arguments, object literals, interfaces, classes, and functions.
- Unified diff rendering and an agent-tool adapter.

For a complete end-to-end example, see [the declarative API tour](./examples/declarative-api-tour.ts). The companion [examples guide](./examples/README.md) covers overlays, query patterns, draft helpers, composition, and policies.

## Programmatic execution

Provide `Workspace.layer(...)` to create planning and verification authority. Add `planApplicationLayerNode` only at the boundary where writes are intended, then apply the verified plan.

```ts
import { Effect, Layer } from "effect"
import {
  Application,
  planApplicationLayerNode,
  Recipe,
  Verification,
  Workspace,
} from "teatime"

const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: "./my-project" })
const applicationLayer = planApplicationLayerNode.pipe(Layer.provideMerge(workspaceLayer))

const receipt = await Effect.runPromise(
  Effect.gen(function*() {
    const plan = yield* Recipe.run(recipe, input)
    const verified = yield* Verification.verify(plan, recipe, input)
    return yield* Application.apply(verified)
  }).pipe(Effect.provide(applicationLayer)),
)
```

## Development

This repository requires Node.js 24+ and pnpm 11+.

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm effect:check
pnpm test
```

`pnpm install` runs `effect-tsgo patch --no-typescript --oxlint`. Oxlint uses the Effect TypeScript-Go integration while the project continues to use its pinned TypeScript 7 installation.

## Repository layout

- `src/api/` — public declarative API and integration tests.
- `src/prototype/` — compiler, plan, verification, and workspace foundations.
- `src/cli/` — CLI, terminal diff rendering, and agent-tool protocol.
- `examples/` — executable tour and supporting guide.
- `fixtures/` — projects used by end-to-end tests.
- `tools/oxlint/anti-slop/` — vendored Oxlint rules.
