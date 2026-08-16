# safemods

Type-directed codemods for TypeScript projects, built on Effect.

`safemods` uses the TypeScript type checker to find exact symbol references across renamed imports, re-exports, and barrel files. Transformations produce range-bounded edits that are validated against type-checking and idempotency policies before anything is written to disk.

```
Query → Draft → Plan → Preview → Verify → Apply
```

---

## Installation

```sh
pnpm add -D safemods effect typescript@7
```

> **Note:** Requires Node 24+ and TypeScript 7+. `effect` and `typescript` are peer dependencies.

---

## Example Recipe

A recipe finds nodes in your project, drafts replacements, and declares verification policies.

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
} from "safemods"

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
    Effect.gen(function* () {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(app)
      const target = yield* project.symbolNamed("target", {
        within: "src/library.ts",
      })

      const calls = yield* Query.calls(project).pipe(
        Query.where(
          Query.resolvesTo(target, {
            location: (call) => call.expression,
          }),
        ),
        Query.filter(
          ({ value: call }) =>
            call.arguments.length === 1 &&
            !isObjectLiteralExpression(call.arguments[0]!),
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

---

## CLI

By default, `safemods run` previews proposed diffs. Use `--verify` to run policy checks, or `--apply` to write changes once verified.

```sh
# Preview diff in terminal
safemods run ./recipe.ts --cwd ./my-project

# Run verification policies without writing
safemods run ./recipe.ts --cwd ./my-project --verify

# Verify and apply changes to disk
safemods run ./recipe.ts --cwd ./my-project --apply
```

If a recipe defines an input Schema, pass parameters via `--input`:

```sh
safemods run ./recipe.ts --cwd ./my-project --input '{"key": "value"}'
```

To export the recipe's input schema:

```sh
safemods tool ./recipe.ts
```

---

## Core Concepts

- **Exact range edits**: Changes target source ranges and verify old-text hashes, leaving surrounding formatting and comments untouched.
- **Symbol renames**: `Draft.renameSymbol` automatically updates declarations, references, and alias imports across the project.
- **In-memory overlays**: `Recipe.pipe` chains recipes in memory, allowing subsequent steps to query against modified ASTs before writing to disk.
- **Policies**:
  - `Policy.matches({ min: 1 })` &mdash; Fails if the query matched no call sites.
  - `Policy.noNewErrors()` &mdash; Checks that the proposed diff introduces no new compiler diagnostics.
  - `Policy.idempotent()` &mdash; Verifies that re-running the recipe against transformed code yields zero further edits.

---

## Programmatic Usage

Recipes can also be executed directly within an Effect workflow:

```ts
import { Recipe, Preview, Verification, Application } from "safemods"

const plan = yield* Recipe.run(recipe, input)
const preview = yield* Preview.of(plan)
const verified = yield* Verification.verify(plan, recipe, input)
const receipt = yield* Application.apply(verified)
```

---

## Development

```sh
pnpm check
pnpm test
```

### Examples & References

- [API Tour](./examples/declarative-api-tour.ts) &mdash; Comprehensive walkthrough of available queries and combinators.
- [Examples](./examples/README.md) &mdash; Sample recipes for renames, migrations, and calls.
- [Context & Architecture](./CONTEXT.md) &mdash; Project terminology and architectural model.
