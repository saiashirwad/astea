# safemods

Type-directed codemods for TypeScript 7 projects, built on [Effect](https://effect.website).

A codemod in safemods is a **recipe**: a program that queries a project through the TypeScript compiler, proposes edits, and hands them to a pipeline that previews, verifies, and only then writes. Nothing touches disk until a plan has passed the type checker and the policies you attached to it.

> Early and moving fast. The API will change.

## Install

```sh
pnpm add -D safemods effect typescript@7
```

Recipes import `effect` and the TypeScript API directly, so both live next to `safemods` in your project. Node 24 or newer.

## A recipe

```ts
// rename-old-name.ts
import { Effect } from "effect"
import * as Draft from "safemods/Draft"
import * as Policy from "safemods/Policy"
import * as Recipe from "safemods/Recipe"
import { ConfiguredProject, WorkspaceSnapshot } from "safemods/Workspace"

const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })

export default Recipe.define("rename-old-name", {
  version: "1.0.0",
  policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
  run: () =>
    Effect.gen(function* () {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(app)
      return yield* Draft.renameSymbolNamed(project, "oldName", "newName", {
        lookupIn: "src/library.ts",
      })
    }),
})
```

This renames the symbol and every reference to it — imports, aliases, re-exports — across the project. The `lookupIn` path only says which `oldName` you mean.

Run it:

```sh
safemods run rename-old-name.ts            # print a diff, write nothing
safemods run rename-old-name.ts --verify   # also type-check and evaluate policies
safemods run rename-old-name.ts --apply    # verify, then write
```

## How it works

Every recipe moves through the same four stages. Each stage is a separate module with its own authority, and the layers below never import the layers above.

```
Query  →  Draft  →  Plan  →  Verification  →  Application
find      propose   freeze   check           write
```

**Query** asks the compiler, not the text. `Query.calls(project)` yields call expressions; `Query.where(Query.resolvesTo(symbol))` keeps the ones whose callee resolves to a particular symbol through any alias or re-export. Results are `Selection`s bound to one immutable snapshot of the project, so a stale node can never leak into a later step.

```ts
const calls = yield* Query.calls(project).pipe(
  Query.where(Query.resolvesTo(target, { location: (call) => call.expression })),
  Query.withArgCount(1),
  Query.within("src/**/*.ts"),
  Query.collect,
)
```

**Draft** accumulates proposed edits. Operations are small and textual — replace a node, add a named import, move a file and fix its importers — so comments and formatting survive. Each edit records a hash of the text it expects to replace.

```ts
yield* Draft.replaceEach(calls, ({ value: call }) => ({
  node: call.arguments[0]!,
  text: `wrap(${call.arguments[0]!.getText()})`,
}))
yield* Draft.imports.addNamed(project, "src/index.ts", { module: "effect", name: "Option" })
yield* Draft.files.move(project, "src/old.ts", "src/new.ts")
```

**Plan** is what a finished Draft becomes: a frozen, serializable list of edits plus a manifest of every file, directory, and config the recipe observed. Its ID is a digest of that content, so the same plan has the same ID on any machine. If any observed input changes before the plan is used, the plan is stale and is rejected rather than silently rebased.

**Verification** is read-only. It re-checks each edit's hash, compiles the proposed result in memory, diffs compiler diagnostics against the baseline, and evaluates policies:

```ts
Policy.noNewErrors()                // no diagnostics that weren't already there
Policy.matches({ min: 1, max: 50 }) // bound the number of matches
Policy.atMostFiles(10)
Policy.fixesError(2345)             // must resolve a specific diagnostic
Policy.allowErrors({ code: 2345, max: 2 })
Policy.idempotent()                 // re-running on the result proposes nothing
```

Passing verification issues a `VerifiedPlan` — a capability that only the Verification module can construct.

**Application** is the one module that writes. Its `apply` accepts a `VerifiedPlan` and nothing else, so there is no path from a Draft to disk that skips the checks. A successful write returns a receipt with the output hash of every file.

## Composing recipes

Recipes are values, so they compose.

```ts
Recipe.pipe(migrateLibrarySignature, updateCallSites) // in sequence
Recipe.all([addImports, removeDeadCode])              // concurrently, merged; conflicting ranges fail
Recipe.when(usesStrictMode, tightenTypes)             // conditionally
```

`Recipe.pipe` runs each later stage against an in-memory **overlay** of the earlier drafts, so the second recipe sees the first one's edits through the type checker without anything being written. The result is still one plan against the original snapshot.

## Patterns

For structural matches, `Pattern` describes the shape and binds the parts you want:

```ts
const pattern = Pattern.callExpression({
  expression: Pattern.identifier({ resolvesTo: target }),
  arguments: Pattern.tuple([Pattern.bind("arg", Pattern.not(Pattern.objectLiteral()))]),
})
const matches = yield* Query.match(project, pattern).pipe(Query.collect)
```

## CLI

```
safemods run  <recipe.ts> [--verify | --apply] [--cwd <dir>] [--input <json>] [--no-color]
safemods scan <recipe.ts> [--json | --csv] [--fail-on-match]
safemods tool <recipe.ts>
```

- `run` previews by default. `--verify` adds the diagnostic diff and policy results; `--apply` writes after a passing verification.
- `scan` runs the query half only and reports matches per file. `--fail-on-match` exits non-zero if anything matched, which makes a recipe usable as a lint in CI.
- `tool` prints the recipe as a JSON-schema tool definition for an agent host.
- `--input` passes the recipe's input, validated against its `schema` if it declares one.

## Agents

A recipe with a `schema` is already a tool. `recipeToAgentTool` wraps it in the shape LLM function-calling expects and returns structured results: plan ID, affected files, diagnostic delta, policy outcomes, or a typed error.

```ts
import { recipeToAgentTool } from "safemods/AgentTool"

const tool = recipeToAgentTool(renameRecipe, "Rename a symbol across the project.")
await tool.execute({ oldName: "foo", newName: "bar", fileName: "src/a.ts" })               // verify only
await tool.execute({ oldName: "foo", newName: "bar", fileName: "src/a.ts" }, { apply: true })
```

An agent gets the same guarantees a human does: it cannot write without a verified plan.

## Programmatic use

```ts
import { Effect, Layer } from "effect"
import * as Application from "safemods/Application"
import { applicationLayerNode, workspaceLayerNode } from "safemods/Node"
import * as Recipe from "safemods/Recipe"
import * as Verification from "safemods/Verification"
import { ConfiguredProject } from "safemods/Workspace"
import recipe from "./rename-old-name.ts"

const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
const workspace = workspaceLayerNode({ projects: [app] }, { cwd: "/path/to/project" })
const runtime = applicationLayerNode.pipe(Layer.provideMerge(workspace))

const program = Effect.gen(function* () {
  const plan = yield* Recipe.run(recipe, undefined)
  const preview = yield* Verification.of(plan)
  const verified = yield* Verification.verify(plan, recipe, undefined)
  const receipt = yield* Application.apply(verified)
  return { preview, receipt }
})

await Effect.runPromise(program.pipe(Effect.provide(runtime)))
```

## Examples

- [Rename a symbol](./examples/rename-symbol.ts)
- [Migrate an import specifier](./examples/migrate-import.ts)
- [Rewrite call arguments by resolved symbol](./examples/semantic-api-migration.ts)
- [Stage an import through an overlay, then query the result](./examples/overlay-aware-migration.ts)
- [Expose a recipe as an agent tool](./examples/agent-tool.ts)
- [Full API tour](./examples/declarative-api-tour.ts)

## Further reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) — module layers and the boundary rules a linter enforces
- [CONTEXT.md](./CONTEXT.md) — the vocabulary: Workspace, Snapshot, Plan, Draft, Application, and what each is not

## Development

```sh
pnpm install
pnpm check        # format, typecheck, effect diagnostics, lint, tests, package smoke
pnpm test src/Draft
```
