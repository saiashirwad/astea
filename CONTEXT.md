# TypeScript Project Transformation

This context describes a standalone system for agents and codemod authors to carry out large, complex TypeScript project transformations reliably through the TypeScript 7 native compiler API.

## Language

**Project Transformation System**:
A standalone system that uses TypeScript's native project semantics to query code, plan changes, verify their consequences, and apply them explicitly.
_Avoid_: AST wrapper, ts-macros extension

**Workspace**:
A non-empty set of Configured Projects that are opened, observed, and transformed as one coordination boundary. A Workspace may contain one project without being a single-project abstraction.
_Avoid_: Repository, mutable project collection

**Configured Project**:
A stable project identity within a Workspace, defined by a TypeScript configuration file and preserved across workspace generations.
_Avoid_: Native compiler Project object, tsconfig contents

**Workspace Snapshot**:
An immutable checked generation of a Workspace containing the corresponding Project Snapshot for each Configured Project.
_Avoid_: Current workspace, mutable compiler state

**Transformation Plan**:
An immutable, content-addressed, serializable proposal for deterministic edits against a particular Project Snapshot; creating or verifying one does not write to the project.
_Avoid_: Mutation, script output

**Draft Plan**:
A recipe-local builder that may consume snapshot-bound Selections while accumulating proposed operations. Finalization either compiles it completely into a durable Transformation Plan or fails without returning a partial plan.
_Avoid_: Persisted live builder, partially valid plan

**Plan ID**:
The digest of a Transformation Plan's canonical durable content, independent of absolute workspace location, time, tracing, and scheduling.
_Avoid_: Random run ID, database identity

**Snapshot Input Manifest**:
The durable record of project, toolchain, source and configuration file contents, containing-directory listings, and project-relative realpaths captured when a Transformation Plan is created. Missing entries cover only unavailable targets found by that deterministic walk; compiler per-open missing-path probes are not a stable durable set, and declared-environment observations are not recorded. Any recorded mismatch makes the Plan stale.
_Avoid_: Edited-file list, source-files-only hash

**Durable Path**:
A project- or workspace-relative, case-preserving path paired with stable project identity for use in plans and evidence. Native canonical and absolute filesystem paths remain runtime lookup details.
_Avoid_: Absolute workspace path, native canonical path

**Transformation Recipe**:
A reusable program, authored through the same API by a human or an agent, that queries a TypeScript project and produces a Transformation Plan.
_Avoid_: Agent-only language, migration script

**Application**:
The explicit act of committing a Transformation Plan to the project. Querying, planning, previewing, and verifying never imply application.
_Avoid_: Save, automatic mutation

**Project Snapshot**:
A checked view of one Configured Project within a particular Workspace Snapshot. Semantic use of native TypeScript nodes, symbols, and types is authorized by that generation; JavaScript object identity does not establish validity across generations.
_Avoid_: Mutable project, persistent node graph

**Snapshot Transition**:
The creation of a new Workspace Snapshot after declaring source or project changes. A Snapshot Transition does not mutate or invalidate an earlier active Workspace Snapshot.
_Avoid_: Refresh, snapshot mutation

**Semantic Query**:
A snapshot-scoped project query whose selections may depend on TypeScript-resolved meaning such as symbols, types, aliases, or references rather than syntax or source text alone.
_Avoid_: Text search, syntax selector

**Selection**:
An occurrence admitted by a Semantic Query, pairing its snapshot-scoped native TypeScript value and source location with Query Evidence explaining why it qualified.
_Avoid_: Unexplained match, persistent node reference

**Query Evidence**:
Deterministic facts produced by query criteria to explain why a Selection qualified. Query Evidence may be incorporated into a Transformation Plan's broader Plan Evidence.
_Avoid_: Boolean predicate result, log message

**Reliability Invariant**:
A safety guarantee enforced by the Project Transformation System that a Transformation Recipe or caller cannot disable.
_Avoid_: Default policy, recommended setting

**Plan Policy**:
An explicit, inspectable condition governing whether a particular Transformation Plan may be verified or applied.
_Avoid_: System invariant, hidden configuration

**Stale Plan**:
A Transformation Plan whose Project Snapshot is no longer the current application target. A Stale Plan must be rejected and recreated rather than silently rebased or re-resolved.
_Avoid_: Outdated edits, automatically refreshed plan

**Verification**:
The read-only evaluation of a Transformation Plan against its Project Snapshot and Plan Policies, including the proposed project's diagnostics and any promised idempotence. Verification never implies Application.
_Avoid_: Dry-run application, validation during writing

**Preview**:
The deterministic, read-only materialization of a Transformation Plan's exact proposed file bytes after all source fingerprints and guarded edits match. A Preview may be rendered as diffs but never writes.
_Avoid_: Dry-run write, approximate patch

**Overlay**:
An isolated Workspace Snapshot of a Draft Plan's proposed files, used to query and author further Drafts without Application. Sequential composition rebases the later Draft onto the original snapshot rather than concatenating Drafts authored against different source states.
_Avoid_: Dry-run write, in-memory mutation, preview on disk

**Verified Plan**:
A process-local capability pairing a Transformation Plan with successful Verification against an exact snapshot. It is the only input accepted by Application; its durable counterpart is the Verification Receipt.
_Avoid_: Boolean valid flag, self-asserted plan

**Verification Receipt**:
A durable result keyed by Plan ID and snapshot hash that records normalized diagnostic and Plan Policy outcomes without changing the Transformation Plan.
_Avoid_: Mutable plan status, compiler log

**Application Receipt**:
A durable result of successful Application containing the Plan ID, snapshot hash, and confirmed output fingerprints. A failure or indeterminate recovery cannot produce a success receipt.
_Avoid_: Console success message, write attempt log

**Plan Evidence**:
Deterministic facts that explain a Transformation Plan's inputs, selections, edits, and Verification results. Operational observations such as timings and trace identifiers are metadata, not Plan Evidence.
_Avoid_: Logs, opaque reasoning

**Node Anchor** _(vocabulary only; not an implemented `NodeAnchor` type or API)_:
A term for serializable Plan Evidence that would locate a native TypeScript node by Configured Project, project-relative file, exact range, syntax kind, and source-text hash. Such evidence would be valid only after the plan's source fingerprints match and would carry no compiler authority.
_Avoid_: Persistent node, fuzzy locator

**Symbol Anchor** _(vocabulary only; not an implemented `SymbolAnchor` type or API)_:
A term for serializable Plan Evidence that would identify a snapshot symbol through its canonical name, flags, and declaration Node Anchors. Such evidence could explain a semantic choice but would not establish symbol identity across Workspace Snapshots.
_Avoid_: Persistent symbol, cross-generation object identity

**Text Edit**:
The canonical change primitive in a Transformation Plan: a project-relative file and half-open source range guarded by the expected old-text hash, plus replacement text and evidence. Insertions and removals are degenerate Text Edits.
_Avoid_: AST mutation, unguarded patch

**Source Fidelity**:
The guarantee that applying Text Edits preserves every source byte outside their explicit ranges. Native AST printing may create replacement fragments but never grants permission to reprint an unrelated file or subtree.
_Avoid_: Pretty-print equivalence, whole-file regeneration
