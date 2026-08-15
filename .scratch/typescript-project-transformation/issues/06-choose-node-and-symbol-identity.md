# Choose node and symbol identity across snapshots

Type: prototype
Status: resolved
Blocked by: 03, 04

## Comments

- Claimed to distinguish live native identity from durable plan locators and test strict re-resolution.

## Question

How should recipes and plans refer to nodes and symbols without recreating ts-morph's forgotten-node failure mode? Test native node handles and symbol identity across snapshots, then choose the lifetime, evidence, re-resolution, and failure semantics for snapshot-bound references and stale plans.

## Answer

Native `Node`, `Symbol`, `Type`, and `NodeHandle` values are live, snapshot-bound capabilities. Recipes may use them inside the `Workspace.withSnapshot` region that produced them, but must not retain them in a Transformation Plan or treat JavaScript object identity as meaningful across Workspace Snapshots. The runtime expiry guard is the failure boundary for an escaped live value; there is no wrapper graph and therefore no ts-morph-style "forgotten node" state to manage.

A finalized plan uses plain serializable evidence instead. The prototype defines a strict `NodeAnchor` containing the Configured Project, project-relative file, exact start and end, `SyntaxKind`, and source-text hash. A `SymbolAnchor` records a canonical symbol's name, flags, and declaration anchors. These are evidence locators, not persistent semantic objects and not authority to operate the compiler.

Re-resolution is deliberately exact: project, file, range, kind, and text must all match. The prototype proves an exact anchor resolves back to the native node and declaration evidence can recover the canonical symbol; a shifted range fails with `AnchorMismatch`. It never searches nearby text, guesses a replacement, or silently rebases. Application first requires the plan's independent source fingerprints to match the target snapshot; anchor re-resolution then supports verification and explanation inside that already-matched snapshot.

Consequences:

- live native identity is useful for fast equality and batching only within one snapshot region;
- finalized plans contain anchors and evidence, never native objects, handles, closures, Effects, or services;
- absolute paths may exist in live workspace identity, while durable evidence uses project-relative paths;
- any source-version mismatch makes the plan stale and requires rerunning the recipe;
- richer fuzzy/rebase locators, if ever added, must be a separate explicit collaboration feature and cannot weaken stale-plan rejection.

Prototype: [`src/prototype/identity.ts`](../../../src/prototype/identity.ts) and [`src/prototype/identity.test.ts`](../../../src/prototype/identity.test.ts).
