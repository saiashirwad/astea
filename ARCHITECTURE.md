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
- `Workspace` is read/compiler authority. It does not import Draft, Edit
  application, Plan, Overlay, Preview, Verification, or Application.
- Preview and Verification are read-only. Only Application has write authority.
- Filesystem and native compiler implementations belong in `Node`.
- CLI code is imported only by CLI entry points and `bin`.

Oxlint enforces cycles, self-imports, package self-imports, feature internals,
and the key layer constraints. Add a boundary before adding an exception.
