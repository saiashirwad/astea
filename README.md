# Teaform

Semantic TypeScript codemods you can preview, verify, and apply with confidence.

Codemods are easy to write. Reliable codemods are not.

Teaform is an Effect-native transformation engine for TypeScript 7. It lets developers and coding agents find code by meaning, propose surgical edits, preview the exact diff, verify compiler impact, and only then write to disk.

```text
Snapshot → Query → Draft → Plan → Preview → Verify → Apply
```

Everything before `Apply` is read-only. `Application.apply` is the single write boundary, and it only accepts a verified plan.

## Why Teaform

- **Semantic, not textual** — match resolved symbols, types, references, and typed AST patterns instead of relying on string search.
- **Surgical by default** — guarded text edits preserve comments, formatting, and every byte outside the intended range.
- **Safe to review** — plans are deterministic and content-addressed, with exact unified-diff previews.
- **Verified before mutation** — enforce match counts, diagnostic policies, and idempotence before a change can be applied.
- **Composable and agent-ready** — combine recipes with in-memory overlays, validate inputs with Effect Schema, or expose a recipe as a structured agent tool.

## Quick start

### Requirements

- Node.js 24+
- pnpm 11+

Teaform is currently developed from source:

```sh
git clone https://github.com/saiashirwad/teaform.git
cd teaform
pnpm install
```

Run the end-to-end API tour:

```sh
node examples/declarative-api-tour.ts
```

## Define a recipe

A recipe queries an immutable project snapshot and returns a draft. You do not manually author source ranges, hashes, or filesystem writes.

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
} from "teaform"

const app = ConfiguredProject.make({
  id: "app",
  config: "tsconfig.json",
})

export default Recipe.define("wrap-target-input", {
  version: "1.0.0",
  policies: [
    Policy.matches({ min: 1 }),
    Policy.noNewErrors(),
    Policy.idempotent(),
  ],
  run: () =>
    Effect.gen(function*() {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(app)
      const target = yield* project.symbolNamed("target", {
        within: "src/library.ts",
      })
      const calls = yield* Query.calls(project).pipe(
        Query.where(Query.resolvesTo(target, { location: (call) => call.expression })),
        Query.filter(
          ({ value: call }) =>
            call.arguments.length === 1 && !isObjectLiteralExpression(call.arguments[0]!),
        ),
        Query.collect,
      )

      return yield* Draft.replaceEach(calls, ({ value: call }) => {
        const argument = call.arguments[0]!
        return {
          node: argument,
          text: `{ value: ${argument.getText()} }`,
        }
      })
    }),
})
```

This recipe finds calls that resolve to the intended target symbol—not merely functions with the same spelling—and wraps their single non-object argument.

## Preview, verify, apply

Recipes are ordinary TypeScript modules exporting a `Recipe` as the default export, as `recipe`, or as another named export.

```sh
# Generate an exact diff without writing to disk.
node bin/teaform.ts run ./recipe.ts \
  --cwd ./my-project \
  --preview

# Preview and verify diagnostics, policies, and idempotence.
node bin/teaform.ts run ./recipe.ts \
  --cwd ./my-project \
  --verify

# Verify first, then apply the verified plan.
node bin/teaform.ts run ./recipe.ts \
  --cwd ./my-project \
  --apply
```

Pass schema-backed recipe input with `--input '<json>'`. Use `--no-color` for plain terminal output and `--help` for the complete CLI reference.

To inspect a recipe as an agent-facing tool:

```sh
node bin/teaform.ts tool ./recipe.ts
```

## Runnable examples

All examples are included in `pnpm typecheck`.

```sh
# Preview a small, safe single-file edit.
node bin/teaform.ts run ./examples/preview-add-call.ts \
  --cwd ./fixtures/basic \
  --preview

# Rename a declaration and all semantic references, including aliases and re-exports.
node bin/teaform.ts run ./examples/rename-symbol.ts \
  --cwd ./fixtures/stress \
  --preview

# Rewrite an import source while preserving the comment inside its import clause.
node bin/teaform.ts run ./examples/migrate-import.ts \
  --cwd ./fixtures/stress \
  --preview
```

Use `--verify` to validate a plan or `--apply` to write it after review.

## What it can transform

- Semantic call sites, symbols, references, types, and project-wide renames.
- Imports, call arguments, object literals, interfaces, classes, and functions.
- Multi-stage migrations through in-memory snapshot overlays.
- File creation, deletion, and moves with relative-import rewriting.
- Unused imports and import organization.
- Diagnostic diffs, no-new-error checks, expected fixes, match policies, and idempotence.
- ANSI unified diffs and schema-validated agent-tool adapters.

## Development

```sh
pnpm check
pnpm effect:check
pnpm test
```

`pnpm install` runs the repository's `prepare` step, which integrates Effect TypeScript-Go diagnostics with Oxlint while keeping the pinned TypeScript 7 toolchain.

## Learn more

See the [declarative API tour](./examples/declarative-api-tour.ts), the [examples and architecture guide](./examples/README.md), and the project transformation vocabulary.
