# teatime

Effect-native TypeScript 7 transformations for reliable, reviewable codemods.

Teatime gives developers and coding agents a semantic pipeline for changing TypeScript projects without re-printing whole files:

```text
Workspace snapshot → Query → Draft → Recipe → Plan → Preview → Verification → Application
```

Planning and verification are read-only. Only `Application.apply` writes to disk, and it accepts a verified plan rather than a raw plan.

## Features

- Semantic AST queries with composable criteria and pattern matchers.
- Type inspection, assignability checks, symbol references, and project-wide renames.
- In-memory snapshot overlays for multi-stage recipes.
- Guarded, minimal text edits that preserve existing comments and formatting.
- Declarative recipes with Effect Schema input validation and policy checks.
- Diagnostic diffs, no-new-error policies, and idempotence verification.
- File lifecycle plans: create, delete, and move files with relative-import rewriting.
- Declaration combinators for interfaces, classes, and functions.
- Import organization and unused-import cleanup.
- ANSI unified diff rendering and an agent-tool adapter.
- CLI support for previewing, verifying, and applying recipes.
- Effect TypeScript-Go diagnostics through `@effect/tsgo` and Oxlint.
- Vendored anti-slop Oxlint rules in `tools/oxlint/anti-slop`.

## Requirements

- Node.js 24+
- pnpm 11+

## Install and validate

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm effect:check
pnpm test
```

`pnpm install` runs the `prepare` script, which patches Oxlint with the Effect TypeScript-Go integration. The patch is intentionally configured with `--no-typescript`; the project continues to use its pinned TypeScript 7 installation directly.

## Public API example

A recipe queries a project snapshot and returns a draft. No ranges, hashes, or filesystem writes are authored manually:

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

export const wrapTargetInput = Recipe.define("wrap-target-input", {
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

Run the explicit pipeline:

```ts
const plan = yield* Recipe.run(wrapTargetInput, undefined)
const preview = yield* Preview.of(plan)
const verified = yield* Verification.verify(plan, wrapTargetInput, undefined)
const receipt = yield* Application.apply(verified)
```

Provide `Workspace.layer(...)` for planning and `planApplicationLayerNode` only when write authority is wanted. See [`examples/declarative-api-tour.ts`](./examples/declarative-api-tour.ts) for a runnable end-to-end example.

## File and declaration transformations

```ts
const created = yield* Draft.files.create(project, "src/new-feature.ts", content)
const removed = yield* Draft.files.delete(project, "src/legacy.ts")
const moved = yield* Draft.files.move(project, "src/old.ts", "src/new.ts")

const withField = yield* Draft.interfaces.addProperty(project, interfaceNode, {
  name: "id",
  type: "string",
})
const withParameter = yield* Draft.functions.addParameter(project, functionNode, {
  name: "options",
  type: "Options",
  optional: true,
})
const withMethod = yield* Draft.classes.addMethod(project, classNode, {
  name: "dispose",
  body: "this.closed = true;",
})
```

All of these produce drafts. They do not mutate the project until a plan passes verification and is explicitly applied.

## CLI

Recipes are TypeScript modules exporting a `Recipe` as `default`, `recipe`, or another named export:

```sh
pnpm exec tsx bin/teatime.ts run ./recipe.ts --cwd ./my-project --preview
pnpm exec tsx bin/teatime.ts run ./recipe.ts --cwd ./my-project --verify
pnpm exec tsx bin/teatime.ts run ./recipe.ts --cwd ./my-project --apply
pnpm exec tsx bin/teatime.ts tool ./recipe.ts
```

Useful flags:

- `--input '<json>'` — recipe input
- `--cwd <path>` — target project directory
- `--no-color` — disable ANSI output
- `--help` — show usage

The diff renderer is also available programmatically through `computeUnifiedDiff`, `renderPlanPreview`, and `renderDiagnosticDiff`. `recipeToAgentTool` exposes a recipe as a validated agent-facing tool with schema, preview, verification, and optional application.

## Tooling

### Effect TypeScript-Go

The repository uses:

- `@effect/tsgo` for Effect-specific diagnostics and the TypeScript-Go integration.
- `oxlint-tsgolint` for type-aware Oxlint integration.
- `oxlint.config.ts` extending the Effect recommended preset.
- `tsconfig.json` configured with the Effect language-service plugin, with diagnostics disabled because Oxlint reports them after patching.

Run Effect diagnostics directly with:

```sh
pnpm effect:check
```

### Anti-slop

The anti-slop plugin is vendored rather than treated as a fixed dependency. Its source is under `tools/oxlint/anti-slop`, and its rules are enabled in `oxlint.config.ts`. This keeps the rules reviewable and locally maintainable.

## Repository layout

- `src/api/` — public declarative API and integration tests.
- `src/prototype/` — native compiler, plan, verification, and workspace foundations.
- `src/cli/` — CLI, terminal diff renderer, and agent-tool protocol.
- `examples/` — executable API tour and supporting guide.
- `tools/oxlint/anti-slop/` — vendored anti-slop Oxlint plugin.
- `fixtures/` — projects used by end-to-end tests.

## Pinned foundation

- TypeScript `7.0.2`
- Effect `4.0.0-rc.109`
- `@effect/vitest` `4.0.0-rc.109`
- `@effect/tsgo` `0.36.5`
- Oxlint `1.78.0`
- Vitest `4.1.10`
- tsx `4.23.12`
