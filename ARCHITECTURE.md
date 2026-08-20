# Architecture

SafeMods is one package organized as domain modules. Dependencies point down:

```text
Cli / AgentTool / bin
          |
       Node adapters
          |
       Execution
          |
     Application
          |
   Verification
          |
Recipe / Preview
          |
 Draft / Overlay / Precondition
          |
 Query / Pattern / Workspace
          |
 Evidence / Edit / Plan / Policy
```

Within the semantic layer, `Query` may depend on `Pattern`, `Workspace`, and
`Evidence`; `Pattern` may depend only on `Workspace` and `Evidence`.

## Boundary rules

- Source modules import concrete domain modules, never `src/index.ts`, the
  root barrel or the package name `safemods`.
- A feature's `internal/` directory is private to that feature.
- `Workspace` is read/compiler authority. It does not import Draft, Edit,
  Plan, Overlay, Preview, Verification, or Application.
- `Recipe` creates plans. `Preview` materializes plan bytes without writes.
  `Verification` checks plans and issues verified authority. `Application` is
  the only write authority and consumes that verified authority. `Execution`
  is the consumer workflow that orchestrates plan, preview, verify, and apply.
  Recipe, Preview, and Verification must not import Application. Recipe and
  Preview must not import Execution.
- Preview and Verification are read-only. Only Application has write authority.
- Filesystem and native compiler implementations are intended to move toward
  `Node`; that direction is not fully realized today. `Workspace` currently
  uses Node filesystem operations directly as the fallback for isolated-overlay
  directory listings. Recipe fingerprinting uses injected `FileSystem` and
  `Path` services. Direct `node:crypto` use is a small foundational exception:
  recipe identity hashing is synchronous and deterministic, and it has no
  filesystem or process authority. Portable project-path identity is independent
  of `Workspace`. Host path resolution is owned by `Node`; semantic callers use
  project-scoped path operations exposed by their active Workspace Snapshot.
- CLI code is imported only by CLI entry points and `bin`.

Oxlint enforces cycles and self-imports. `tools/check-boundaries.mjs` classifies
every production domain, enforces the layer direction, protects feature
internals, and rejects package and root self-imports. Existing upward imports
into `Node` and `platform` are listed as temporary adapter migrations in that
checker. Remove an exception when its owner moves to injected services. Do not
add an exception without updating this document.
