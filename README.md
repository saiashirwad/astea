# safemods

Type-aware codemods for TypeScript 7 projects.

`safemods` uses the TypeScript compiler to find code by meaning, not just by
syntax. A recipe can follow a symbol through imports, aliases, and re-exports,
then propose small text edits without mutating the compiler AST or reprinting
whole files.

Planning, previewing, and verification are read-only. Writing is a separate
step that accepts only a verified plan.

```text
query -> draft -> plan -> preview -> verify -> apply
```

## Requirements

- Node.js 24 or newer
- TypeScript 7
- ESM

## Install

```sh
pnpm add -D safemods effect typescript@7
```

Recipes commonly import `effect` and the TypeScript AST API directly, so both
packages should be available in the project that contains your recipes.

## Quick start

This recipe renames one declaration and every reference that resolves to the
same TypeScript symbol:

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

Preview the exact changes:

```sh
pnpm exec safemods run ./rename-old-name.ts --cwd ./path/to/project
```

Verify the preview against the TypeScript compiler and the recipe's policies:

```sh
pnpm exec safemods run ./rename-old-name.ts --cwd ./path/to/project --verify
```

Apply it:

```sh
pnpm exec safemods run ./rename-old-name.ts --cwd ./path/to/project --apply
```

`--apply` includes verification. The CLI uses `tsconfig.json` in `--cwd` and
loads the first exported recipe it finds, preferring a default export or an
export named `recipe`.

## Capabilities

| Area                    | What is available                                                                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace               | Immutable snapshots of one or more configured TypeScript projects, symbol and type lookup, file dependency queries, and explicit snapshot transitions.                                                                                                            |
| Query                   | Streams of calls, imports, identifiers, property accesses, arbitrary node kinds, symbol references, and structural pattern matches. Queries can be scoped by file and filtered by text, argument count, type, symbol, JSDoc, export status, or AST relationships. |
| Pattern                 | Composable matchers for expressions, declarations, control flow, tuples, bindings, predicates, and computed TypeScript types.                                                                                                                                     |
| Precondition            | Fast file filtering by path, text, or imported module before doing AST or type-checker work.                                                                                                                                                                      |
| Draft                   | Guarded text replacement, insertion, removal, and printing, plus operations for imports, file operations, symbol renames, and unused imports.                                                                                                                     |
| File operations         | Create, delete, and move files. Moving a file also updates matching relative imports.                                                                                                                                                                             |
| Recipe                  | Schema-validated inputs, two-phase scans, sequential or concurrent composition, conditional branches, and in-memory handoff between recipe stages.                                                                                                                |
| Plan and Preview        | Deterministic, serializable, content-addressed plans and exact read-only previews.                                                                                                                                                                                |
| Policy and Verification | Match bounds, affected-file limits, diagnostic diffs, diagnostic-code rules, custom checks, and idempotence.                                                                                                                                                      |
| Application             | Stale-plan checks, staged writes, rollback, and receipts for successfully committed output.                                                                                                                                                                       |
| CLI and AgentTool       | Human-readable diffs, JSON/CSV audit reports, CI-friendly match detection, recipe JSON Schema export, and a programmatic agent-tool adapter.                                                                                                                      |

The root package exports the main domains as namespaces:

```ts
import {
  Application,
  Draft,
  Overlay,
  Pattern,
  Policy,
  Precondition,
  Query,
  Recipe,
  Verification,
  Workspace,
} from "safemods"
```

Each domain is also available as a subpath, such as `safemods/Query`.
Lower-level `Edit`, `Evidence`, and `Plan` modules are public as well. Node
runtime layers, CLI helpers, and the agent adapter live at `safemods/Node`,
`safemods/Cli`, and `safemods/AgentTool`.

## Querying code

Queries return Effect streams of `Selection` values. A selection contains the
typed compiler node, its project and source range, and evidence describing why
it matched.

```ts
const matchingCalls = Query.calls(project).pipe(
  Query.where(Query.resolvesTo(target, { location: (call) => call.expression })),
  Query.withArgCount(1),
  Query.within("src/**/*.ts"),
)
```

The built-in query sources are `nodes`, `calls`, `imports`, `identifiers`,
`propertyAccesses`, `referencesTo`, and `match`. Semantic criteria include
`resolvesTo`, `typeAssignableTo`, `typeSatisfies`, `hasJSDocTag`, and
`isExported`. `inside`, `has`, `precedes`, and `follows` cover common AST
relationships.

For structural matching, `Pattern` includes expression, declaration, and
control-flow matchers along with `bind`, `tuple`, `not`, and custom predicates.
Use `Precondition.filesMatching` to narrow a project to likely files before
running a query.

## Drafting changes

The basic draft operations are `replace`, `remove`, `insertBefore`,
`insertAfter`, `replaceWith`, `replaceEach`, and `print`. Domain operations cover project
and import structure:

```ts
Draft.imports.addNamed(project, "src/index.ts", {
  module: "effect",
  name: "Option",
})
Draft.replace(project, targetNode, "{ value: 1 }")
Draft.files.move(project, "src/old.ts", "src/new.ts")
```

Each operation returns an Effect that produces a `Draft`. Combine drafts with
`Draft.concat` before returning from the recipe.

Every text edit records its expected source hash. Bytes outside the edited
ranges are left alone, including comments and formatting. Overlapping or
otherwise invalid edits are rejected while the plan is built.

## Composing recipes

- `Recipe.pipe(a, b)` runs stages in order. Later stages query an in-memory
  overlay containing earlier changes, then Overlay rebases their Drafts onto
  the original snapshot.
- `Recipe.all([a, b])` runs independent recipes concurrently and merges their
  drafts.
- `Recipe.branch(...)` and `Recipe.when(...)` choose work from the current
  snapshot.
- `Recipe.scanning(...)` separates a workspace-wide analysis pass from the
  transformation pass.
- `Overlay.composeDraft(draft, effect)` runs a later Draft against an overlay
  of an earlier one and returns one Draft against the original snapshot.
- `Overlay.run(draft, effect)` exposes any draft as a new in-memory compiler
  snapshot without writing it. Use it to inspect an overlay or return
  something other than a Draft.

Recipes may declare an Effect `Schema` for typed input. Pass input through the
CLI as JSON:

```sh
pnpm exec safemods run ./recipe.ts --input '{"property":"value"}'
```

The CLI parses `--input` as JSON when possible. If the value is not valid JSON,
it passes the raw string to the recipe; a declared recipe schema then decides
whether that value is valid. Hyphen-prefixed values such as the JSON number
`-1` can be passed as `--input=-1` or as `--input -1`.

## Verification and application

The safety boundary is enforced by the API, not by CLI convention:

1. `Recipe.run` creates a plan and fingerprints the configured projects.
2. `Verification.of` materializes the proposed bytes without writing them.
3. `Verification.verify` compiles the proposed state in memory and evaluates
   the plan policies.
4. `Application.apply` accepts the resulting `VerifiedPlan`; it does not accept
   a raw plan.

Verification compares proposed diagnostics with the baseline, so an existing
error does not fail `Policy.noNewErrors()` unless the change introduces a new
error. `Policy.idempotent()` reruns the recipe over its proposed output and
requires the second run to produce no changes.

Immediately before applying, safemods checks that the plan still matches the
workspace snapshot. Writes are staged and moved into place. If a commit fails,
the application layer attempts to restore the original files; if recovery
cannot be confirmed, it reports an indeterminate application instead of a
success receipt.

## CLI reference

```sh
# Preview a plan (the default run mode)
safemods run ./recipe.ts [--cwd ./project] [--input '{...}']

# Compatibility spelling for the same preview mode; --preview is a no-op
safemods run ./recipe.ts --preview

# Preview and verify
safemods run ./recipe.ts --verify

# Preview, verify, and apply
safemods run ./recipe.ts --apply

# Report matched selections without writing
safemods scan ./recipe.ts
safemods scan ./recipe.ts --format json
safemods scan ./recipe.ts --format csv

# Useful for CI audits: exit 1 when the recipe finds a match
safemods scan ./recipe.ts --fail-on-match

# Print the recipe's agent-tool descriptor and JSON Schema
safemods tool ./recipe.ts
```

`--format` accepts `text`, `json`, or `csv`; `--json` and `--csv` are scan-only
shortcuts. `--fail-on-match` is also scan-only. Use `--no-color` or the
`NO_COLOR` environment variable for plain output. Exactly one recipe path is
accepted.

For compatibility, the command may be omitted: a lone recipe path behaves as
`run`, `--scan` selects the `scan` command, and `--tool-schema` selects the
`tool` command. Prefer the explicit commands in new scripts.

## Programmatic use

The same pipeline can run inside an Effect application:

```ts
import { Effect, Layer } from "effect"
import * as Application from "safemods/Application"
import { applicationLayerNode } from "safemods/Node"
import * as Recipe from "safemods/Recipe"
import * as Verification from "safemods/Verification"
import { ConfiguredProject, Workspace } from "safemods/Workspace"
import recipe from "./rename-old-name.ts"

const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: "/path/to/project" })
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

For read-only use, provide `workspaceLayer` and stop before application. A
programmatic workspace may contain multiple configured projects; the current
CLI opens the single `tsconfig.json` project described above.

## Development

```sh
pnpm install
pnpm check
```

`pnpm check` runs formatting, TypeScript and Effect diagnostics, linting,
tests, and a packed-package smoke test. `pnpm build` creates the ESM package in
`dist`.

More examples:

- [Rename a symbol](./examples/rename-symbol.ts)
- [Migrate an import](./examples/migrate-import.ts)
- [Query and replace a call argument](./examples/preview-add-call.ts)
- [Full API tour](./examples/declarative-api-tour.ts)
- [Architecture](./ARCHITECTURE.md)
- [Domain terminology](./CONTEXT.md)
