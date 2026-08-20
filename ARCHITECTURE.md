# Architecture

SafeMods is one package organized as domain modules. Dependencies point down:

```text
Cli / AgentTool / bin
          |
       Node adapters
          |
Recipe / Preview / Verification / Application
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
- Preview and Verification are read-only. Only Application has write authority.
- Filesystem and native compiler implementations are intended to move toward
  `Node`; that direction is not fully realized today. `Workspace` currently
  uses Node filesystem operations directly as the fallback for isolated-overlay
  directory listings. Recipe fingerprinting currently uses Node filesystem
  APIs (through the local `node:fs` adapter) and `node:crypto` directly. Portable
  project-path identity is independent of `Workspace`. Host path resolution is
  owned by `Node`; semantic callers use project-scoped path operations exposed
  by their active Workspace Snapshot.
- CLI code is imported only by CLI entry points and `bin`.

Oxlint enforces cycles and self-imports. `tools/check-boundaries.mjs` classifies
every production domain, enforces the layer direction, protects feature
internals, and rejects package and root self-imports. Existing upward imports
into `Node` and `platform` are listed as temporary adapter migrations in that
checker. Remove an exception when its owner moves to injected services. Do not
add an exception without updating this document.
