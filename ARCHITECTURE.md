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
- `Workspace` owns the synchronous `WorkspaceRuntime` port for TypeScript
  compiler-host callbacks. `Node` provides its concrete filesystem and path
  implementation. This port is synchronous because TypeScript calls its host
  callbacks synchronously; do not use Effect filesystem operations inside those
  callbacks. Recipe fingerprinting uses injected `FileSystem` and `Path`
  services. Direct `node:crypto` use in Recipe identity and Workspace observed
  input hashing is a small foundational exception: deterministic hashing has no
  filesystem or process authority. Portable
  project-path identity is independent of `Workspace`. Host path resolution is
  owned by `Node`; semantic callers use project-scoped path operations exposed
  by their active Workspace Snapshot. `Workspace/ProjectPath.ts` is the one
  compatibility façade that re-exports legacy Node path helpers. New Workspace
  implementation files must use `WorkspaceRuntime`; the boundary checker allows
  this exception only for that façade file.
- CLI code is imported only by CLI entry points and `bin`.

Oxlint enforces cycles and self-imports. `tools/check-boundaries.mjs` classifies
every production domain, enforces the layer direction, protects feature
internals, and rejects package and root self-imports. Temporary adapter imports
are listed in that checker. Remove an exception when its owner moves to injected
services. Do not add an exception without updating this document.
