# safemods

Type-directed codemods for TypeScript 7 projects, built on Effect.

`safemods` finds code by meaning, not syntax: a recipe can follow a symbol
through imports, aliases, and re-exports, then propose small guarded text
edits — never AST mutation, never whole-file reprints. Every change travels
the same path:

```text
query -> draft -> plan -> preview -> verify -> apply
```

Planning, previewing, and verification are read-only. Writing is a separate
step that accepts only a verified plan.

## safemods is not a linter

A linter reports findings and offers per-file quick-fixes; its contract ends
at "I told you about it." safemods owns what happens _after_ detection:
multi-file coordinated edits, symbol-accurate renames, compiler-checked
verification, and atomic application with rollback.

The division of labor:

- **oxlint / ESLint** — fast detection, rule catalogs, small mechanical fixes.
  If a change is expressible as a lint rule plus an autofix, use a linter.
- **safemods** — transformations that must resolve types and symbols, span
  many files, compose in stages, or be provably safe before anything is
  written.

## Requirements

- Node.js 24 or newer
- TypeScript 7
- ESM

## Install

```sh
pnpm add -D safemods effect typescript@7
```

Recipes import `effect` and the TypeScript AST API directly, so both packages
should be installed alongside `safemods`.

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

Verify against the TypeScript compiler and the recipe's policies:

```sh
pnpm exec safemods run ./rename-old-name.ts --cwd ./path/to/project --verify
```

Apply:

```sh
pnpm exec safemods run ./rename-old-name.ts --cwd ./path/to/project --apply
```

`--apply` includes verification. The CLI opens the `tsconfig.json` project in
`--cwd` and loads the first exported recipe it finds, preferring a default
export, then an export named `recipe`.

## The moving parts

| Domain                  | Role                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace               | Immutable snapshots of one or more configured TypeScript projects; symbol, type, and dependency lookup; explicit snapshot transitions.          |
| Query                   | Effect Streams of `Selection`s: calls, imports, identifiers, property accesses, symbol references, structural matches — each with evidence.     |
| Pattern                 | Composable matchers for expressions, declarations, control flow, tuples, bindings, and computed TypeScript types.                               |
| Precondition            | Fast file filtering by path, text, or imported module before AST or type-checker work.                                                          |
| Draft                   | Guarded text replacement, insertion, removal, printing; import surgery; file create/delete/move; project-wide symbol renames.                   |
| Overlay                 | Run later stages against an in-memory snapshot of earlier changes, rebased onto the original snapshot.                                          |
| Recipe                  | Schema-validated inputs, two-phase scans, sequential/concurrent composition, conditional branches.                                              |
| Plan                    | Deterministic, content-addressed, serializable proposals; identical inputs yield identical plan IDs.                                            |
| Policy and Verification | Match bounds, file limits, diagnostic diffs, diagnostic-code rules, custom checks, idempotence — evaluated read-only against the real compiler. |
| Application             | Stale-plan rejection, staged writes, rollback, crash recovery, receipts.                                                                        |

Root barrel namespaces: `Application`, `Draft`, `Edit`, `Evidence`, `Overlay`,
`Pattern`, `Plan`, `Policy`, `Precondition`, `Query`, `Recipe`, `Verification`,
`VirtualFs`, `Workspace`. Each is also a subpath (`safemods/Query`, …); the
Node runtime layers, CLI helpers, and agent adapter live at `safemods/Node`,
`safemods/Cli`, and `safemods/AgentTool`.

## Querying code

Queries return Effect Streams of `Selection` values. A selection pairs the
typed compiler node and its source range with evidence explaining why it
matched.

```ts
const matchingCalls = Query.calls(project).pipe(
  Query.where(Query.resolvesTo(target, { location: (call) => call.expression })),
  Query.withArgCount(1),
  Query.within("src/**/*.ts"),
  Query.collect,
)
```

- **Sources**: `nodes`, `calls`, `imports`, `identifiers`, `propertyAccesses`,
  `referencesTo`, `match`.
- **Semantic criteria**: `resolvesTo`, `typeOf`, `typeAssignableTo`,
  `typeSatisfies`, `hasJSDocTag`, `isExported`.
- **Operators**: `where`, `filter`, `textMatches`, `within`, `withArgCount`,
  `collect`; combine criteria with `Criterion.all`, `Criterion.any`,
  `Criterion.not`.
- **Relations**: `inside`, `has`, `precedes`, `follows`.
- **Structural matching**: `Pattern` provides expression, declaration, and
  control-flow matchers plus `bind`, `tuple`, `not`, and custom predicates.
- **Pre-filtering**: `Precondition.filesMatching` narrows a project to likely
  files before queries run.

## Drafting changes

Basic operations are `replace`, `remove`, `insertBefore`, `insertAfter`,
`replaceWith`, `replaceEach`, and `print`. Domain operations cover project and
import structure:

```ts
Draft.imports.addNamed(project, "src/index.ts", {
  module: "effect",
  name: "Option",
})
Draft.replace(project, targetNode, "{ value: 1 }")
Draft.files.move(project, "src/old.ts", "src/new.ts")
```

Each operation returns an Effect producing a `Draft`; combine drafts with
`Draft.concat` (or `concatEffect`) before returning from the recipe.

Every text edit records a SHA-256 hash of the exact source range it replaces.
Bytes outside edited ranges are left alone — comments and formatting survive.
Overlapping or out-of-bounds edits are rejected while the plan is built, and a
hash mismatch at any later stage fails the plan as stale rather than guessing.

Notable behaviors:

- `Draft.files.move` rewrites matching relative imports in referencing files
  _and_ in the moved file itself; bare specifiers are untouched.
- `Draft.imports.addNamed` is idempotent: an existing binding yields an empty
  draft instead of a duplicate.
- `Draft.renameSymbolNamed` returns an empty draft when the symbol is absent,
  which makes reruns naturally idempotent.
- `Draft.audit` records selections as evidence with zero edits — read-only
  inventorying, and what powers `safemods scan`.

## Composing recipes

- `Recipe.pipe(a, b)` runs stages in order. Each later stage queries an
  in-memory overlay of earlier changes; `Overlay` rebases its draft onto the
  original snapshot so one coherent plan results.
- `Recipe.all([a, b])` runs independent recipes concurrently and merges their
  drafts.
- `Recipe.branch(predicate, ifTrue, ifFalse)` and `Recipe.when(predicate, r)`
  choose work from the current snapshot.
- `Recipe.scanning(name, { scan, run })` separates a workspace-wide analysis
  pass from the transformation pass, sharing one snapshot region.
- `Overlay.composeDraft(draft, effect)` composes a later draft against an
  overlay of an earlier one. `Overlay.run(draft, effect)` exposes any draft as
  a new in-memory compiler snapshot without writing — use it to inspect an
  overlay or return something other than a draft.

Recipes may declare an Effect `Schema` for typed input. Pass input through the
CLI as JSON:

```sh
pnpm exec safemods run ./recipe.ts --input '{"property":"value"}'
```

`--input` is parsed as JSON when possible; otherwise the raw string is passed
to the recipe's schema. Hyphen-prefixed values such as `-1` work as
`--input=-1` or `--input -1`.

## The safety model

The safety boundary is enforced by the API, not by CLI convention:
`Application.apply` accepts only a `VerifiedPlan` — a process-local capability
issued by successful verification — and rejects raw plans at the type level
and at runtime.

**Policies** declare what a plan promises. Combinators intersect child
policies automatically:

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

**Verification** is read-only. It validates the plan's structure and content
hash, checks recipe/toolchain/project identity, revalidates every source
fingerprint (any drift fails the plan as stale), compiles baseline and
proposed states in isolated in-memory snapshots, diffs their diagnostics, and
evaluates policies. An existing error does not fail `noNewErrors()` unless the
change introduces a new one. `idempotent()` replays the recipe over its own
proposed output and requires zero new proposals.

**Application** re-checks staleness immediately before writing, stages each
file to a temporary, and commits atomically. A failed commit rolls back
applied files; if recovery cannot be confirmed, safemods reports an
indeterminate application instead of a success receipt. A journal enables
crash recovery, and successful commits return a receipt containing the plan
ID, snapshot hash, and output fingerprints.

## CLI reference

```sh
# Preview a plan (the default run mode)
safemods run ./recipe.ts [--cwd ./project] [--input '{...}']

# Preview and verify
safemods run ./recipe.ts --verify

# Preview, verify, and apply
safemods run ./recipe.ts --apply

# Report matched selections without writing
safemods scan ./recipe.ts
safemods scan ./recipe.ts --format json   # or csv; --json / --csv are shortcuts

# CI audits: exit 1 when the recipe finds a match
safemods scan ./recipe.ts --fail-on-match

# Print the recipe's agent-tool descriptor and JSON Schema
safemods tool ./recipe.ts
```

Use `--no-color` or the `NO_COLOR` environment variable for plain output.
Exactly one recipe path is accepted. For compatibility, a lone recipe path
behaves as `run`, `--scan` selects `scan`, `--tool-schema` selects `tool`, and
`--preview` is accepted as a no-op. Prefer the explicit commands in new
scripts.

## Programmatic use

The same pipeline runs inside an Effect application:

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

For read-only use, stop before `Application.apply` and provide a Node-backed
workspace layer such as `workspaceLayerNode` (planning and verification also
need filesystem and path services, which the Node layer supplies).
Programmatic workspaces may contain multiple configured projects; the CLI
opens the single `tsconfig.json` project shown above.

## Agent tools

Any recipe becomes a typed tool for LLM function-calling protocols (OpenAI /
MCP / Anthropic style):

```ts
import { recipeToAgentTool } from "safemods/AgentTool"

const tool = recipeToAgentTool(recipe)
// tool.name, tool.schema (JSON Schema from the recipe's Effect Schema),
// tool.execute(input, { apply?: boolean }) -> planId, status, affectedFiles,
// diagnosticDelta, idempotenceChecked, files, diagnostics, policyResults
```

`execute` verifies by default and only writes when called with
`{ apply: true }`, so an agent can always preview before committing.
`safemods tool ./recipe.ts` prints the same descriptor as JSON.

## Development

```sh
pnpm install
pnpm check
```

`pnpm check` runs formatting, TypeScript and Effect diagnostics, linting,
tests, and a packed-package smoke test. `pnpm build` creates the ESM package
in `dist`.

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
