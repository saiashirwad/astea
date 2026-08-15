# teatime

Effect-native TypeScript 7 project transformations for reliable, large-scale codemods.

Teatime helps agents and developers query TypeScript projects semantically, construct deterministic and inspectable change plans, verify their consequences, and explicitly apply minimal source edits.

## Where things stand

- **Candidate public API** — executable in [`src/api/`](./src/api/), proven end to end against the native compiler; design decisions recorded in the [public API design document](./.scratch/typescript-project-transformation/briefing/public-api-design.md).
- **Production contract** — the [implementation-ready candidate specification](./.scratch/typescript-project-transformation/briefing/implementation-ready-specification.md) fixes the behavior implementation must preserve.
- **Prototype evidence** — executable experiments in `src/prototype/`; decision rationale lives in the [Wayfinder map](./.scratch/typescript-project-transformation/map.md).

## Example

A Transformation Recipe is a reusable program — written once by a human or an agent — that queries a snapshot and proposes edits. This one wraps the argument of every call to the canonical `target` symbol in an object, through import aliases and re-exports, preserving comments and formatting:

```ts
import { Effect } from "effect"
import { isObjectLiteralExpression } from "typescript/unstable/ast/is"
import { ConfiguredProject, Draft, Policy, Query, Recipe, WorkspaceSnapshot } from "teatime"

const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })

export const wrapTargetInput = Recipe.define("wrap-target-input", {
  version: "1.0.0",
  policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
  run: (input: { readonly property: string }) =>
    Effect.gen(function*() {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(app)
      const target = yield* project.symbolNamed("target", { within: "src/library.ts" })

      const matches = yield* Query.calls(project).pipe(
        Query.where(Query.resolvesTo(target, { location: (call) => call.expression })),
        Query.filter(({ value: call }) =>
          call.arguments.length === 1 && !isObjectLiteralExpression(call.arguments[0]!)),
        Query.collect,
      )

      // Ranges, hashes, file identity, and evidence are derived — the author
      // writes none of them. Nothing has been written or finalized yet.
      return yield* Draft.replaceEach(matches, ({ value: call }) => {
        const argument = call.arguments[0]!
        return { node: argument, text: `{ ${input.property}: ${argument.getText()} }` }
      })
    }),
})
```

Running it moves through explicit stages — query, plan, preview, verify, apply — and only the last one touches the filesystem:

```ts
import { Effect, Layer } from "effect"
import {
  Application,
  planApplicationLayerNode,
  Preview,
  Recipe,
  Verification,
  Workspace,
} from "teatime"

const program = Effect.gen(function*() {
  const plan = yield* Recipe.run(wrapTargetInput, { property: "value" })
  // Plans are canonical, content-addressed JSON — Plan.serialize and
  // Plan.parse carry them across process boundaries for review or resumption.

  const preview = yield* Preview.of(plan) // exact proposed bytes, no writes
  const verified = yield* Verification.verify(plan, wrapTargetInput, { property: "value" })
  // Fresh compiler authorities check baseline vs. proposed diagnostics,
  // evaluate every policy, and replay the recipe to prove idempotence.

  return yield* Application.apply(verified) // the only write in the system
})

const layer = planApplicationLayerNode.pipe(
  Layer.provideMerge(Workspace.layer({ projects: [app] }, { cwd: process.cwd() })),
)

await Effect.runPromise(program.pipe(Effect.provide(layer)))
```

Application accepts only a Verified Plan — passing a raw plan is a compile error, not a runtime mistake. A dry run is `Recipe.run` + `Preview` + `Verification`, with `planApplicationLayerNode` simply left out of the layer.

## Requirements

- Node.js 24 or later
- pnpm 11.17.0

## Commands

```sh
pnpm install
pnpm check   # typecheck
pnpm test    # prototype suites plus the candidate API pipeline tests
```

Each prototype experiment also runs standalone via `pnpm prototype:<name>`:

- `native` — spawn the pinned TypeScript 7 native compiler, open the fixture project, read a source file, request semantic diagnostics
- `lifecycle` — scoped snapshots: updates, object identity, disposal, semantic batching, timing, hybrid AST printing, in-memory overlays
- `workspace` — region-scoped workspace/snapshot domain model; semantic use is rejected after the region closes
- `query` — select call expressions by canonical symbol across aliases and re-exports; batched criteria, deterministic evidence, native references
- `identity` — strict, serializable node and symbol anchors across snapshots
- `edits` — guarded minimal text edits and native fragment printing
- `requests` — Effect Request batching compared with direct native array calls
- `plan` — canonical, content-addressed JSON Transformation Plans
- `verification` — stale-safe preview, verification, and explicit application
- `end-to-end` — one alias-aware, idempotent recipe from semantic query to two-file application
- `stress` — import and symbol recipes; ambiguity, baseline diagnostics, idempotence, trivia, and staleness behavior
- `contract` — facade composition and type inference; manifest-observation feasibility

## Pinned foundation

- TypeScript 7.0.2
- Effect 4.0.0-rc.109
- Vitest 4.1.10
- tsx 4.23.12
