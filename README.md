# teatime

Effect-native TypeScript 7 project transformations for reliable, large-scale codemods.

Teatime is a proof of concept for an API that helps agents and developers query TypeScript projects semantically, construct deterministic and inspectable change plans, verify them against the next project state, and explicitly apply minimal source edits.

The public API is intentionally not designed yet. Executable experiments live under `src/prototype/` while the decisions are worked through in the [Wayfinder map](./.scratch/typescript-project-transformation/map.md).

## Requirements

- Node.js 24 or later
- pnpm 11.17.0

## Commands

```sh
pnpm install
pnpm check
pnpm test
pnpm prototype:native
pnpm prototype:lifecycle
pnpm prototype:workspace
pnpm prototype:query
pnpm prototype:identity
pnpm prototype:edits
pnpm prototype:requests
pnpm prototype:plan
pnpm prototype:verification
pnpm prototype:end-to-end
```

`prototype:native` spawns the pinned TypeScript 7 native compiler API, opens the filesystem-backed fixture project, reads its source file, and requests semantic diagnostics.

`prototype:lifecycle` is a throwaway Effect-scoped experiment covering snapshot updates, object identity, disposal, semantic batching, timing instrumentation, hybrid AST printing, and an in-memory overlay over the real fixture filesystem.

`prototype:workspace` exercises the selected region-scoped workspace and snapshot domain model. It keeps configured projects as plain values, provides a temporary workspace-generation capability through Effect context, and prevents semantic use after the region closes.

`prototype:query` selects native call-expression nodes by canonical TypeScript symbol across import aliases and re-exports. It demonstrates composable stream queries, batched checker predicates, deterministic selection evidence, and project-wide native references.

The remaining prototypes exercise strict node/symbol evidence anchors, guarded minimal edits and native fragment printing, Effect Request batching, canonical JSON plans, stale-safe preview/verification/application, and one alias-aware idempotent recipe from semantic query through explicit two-file application.

## Pinned foundation

- TypeScript 7.0.2
- Effect 4.0.0-rc.109
- Vitest 4.1.10
- tsx 4.23.12
