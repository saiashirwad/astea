# TypeScript Project Transformation System — implementation-ready candidate specification

Status: candidate implementation contract for issue 12

Baseline: TypeScript 7 native async API and Effect 4

Audience: production implementers and the subsequent public-API design session

This document fixes the behavior that implementation must preserve. Names and fluent authoring ergonomics remain deliberately provisional: the project owner intends to shape those after the prototypes. A proposed facade is executable in `src/prototype/public-api-probe.ts`; it is evidence that the concepts compose and infer, not a claim that those are the final names.

## 1. Product contract

The system is an Effect-native transaction layer over native TypeScript 7 project snapshots for reliable, large-scale codemods. Agents and human authors use the same TypeScript API.

A successful run has this state progression:

```text
Workspace
  └─ Workspace Snapshot region
       └─ Transformation Recipe → Draft Plan
            └─ finalization → durable Transformation Plan
                 └─ Preview → exact proposed bytes
                      └─ isolated Verification → Verified Plan + Verification Receipt
                           └─ explicit Application → Application Receipt
```

No stage before Application may write project files. Application cannot accept an unverified plan.

### Goals

- Native TypeScript nodes and the native checker remain the syntax and semantic authority.
- Large codemods produce deterministic, explainable, reviewable, resumable plans.
- Project state changes are detected rather than silently rebased.
- Unedited source bytes are preserved.
- Effect owns lifecycle, capabilities, typed failures, tracing, and concurrency.
- The model supports a non-empty set of configured projects even when the first implementation optimizes one.
- Recipe authoring has excellent inference and no parallel node hierarchy.

### Non-goals for the first production slice

- TypeScript 6 or the legacy in-process compiler API.
- A production CLI, MCP server, editor extension, or hosted service.
- A catalogue matching every ts-morph convenience method.
- Automatic stale-plan rebasing or distributed application.
- Power-loss atomicity across files before a durable journal exists.
- A custom semantic type system or owned AST hierarchy.

## 2. Compatibility baseline

- Node.js 24 or later.
- TypeScript 7 through `typescript/unstable/async`, `typescript/unstable/ast`, and related unstable entrypoints.
- Effect 4.
- The native TypeScript adapter is pinned to an exact TypeScript version until the API is stable. A TypeScript upgrade must run the lifecycle, query, identity, manifest, and end-to-end compatibility suites before release.
- Durable plans carry a schema version and exact toolchain identity. Readers reject unsupported schema versions and mismatched toolchains; schema migration is an explicit offline operation.
- Types exported from TypeScript's unstable AST are intentionally visible in recipe signatures. The package's compatibility policy must state that TypeScript minor upgrades may require a matching package minor during the unstable period.
- `unsafeNative` is an explicitly unstable escape hatch and receives no facade-level compatibility guarantee beyond snapshot expiry enforcement.

## 3. Domain model

The canonical terms and definitions live in `CONTEXT.md`. The implementation must preserve these relationships:

- A **Workspace** is a non-empty coordination boundary containing Configured Projects.
- A **Configured Project** has a stable caller-visible project ID and a workspace-relative configuration path. An absolute path is runtime configuration, not durable identity.
- `Workspace.withSnapshot` introduces a **Workspace Snapshot** region.
- A **Project Snapshot** is obtained explicitly from that region for one Configured Project.
- Native nodes, symbols, types, and handles are live values valid only inside the producing region.
- A **Transformation Recipe** evaluates in that region and produces a **Draft Plan**.
- Finalization produces a durable **Transformation Plan** containing no live capability.
- A **Preview** materializes exact proposed bytes without writing.
- **Verification** evaluates the proposed state with isolated compiler authority.
- A **Verified Plan** is process-local application authority; durable Verification and Application Receipts carry later observations.

## 4. Public capability boundary

Only authority and lifecycle seams are Effect services.

### 4.1 `Workspace`

Public application service. It owns workspace configuration, read-only source access, native compiler lifecycle, transition serialization, and isolated verification sessions.

Required operation:

```ts
interface WorkspaceService {
  readonly withSnapshot: <A, E, R>(
    transition: SnapshotTransition,
    program: Effect.Effect<A, E, R | WorkspaceSnapshot>,
  ) => Effect.Effect<A, E | WorkspaceError, Exclude<R, WorkspaceSnapshot>>
}
```

The service is constructed from a `WorkspaceDefinition` with one or more explicitly identified Configured Projects. Creating native generations is serialized; work inside already-created snapshot regions may overlap.

### 4.2 `WorkspaceSnapshot`

Region-provided public capability. It exposes its generation evidence and resolves a Configured Project to a Project Snapshot. Every operation checks that the region is active.

```ts
interface WorkspaceSnapshotService {
  readonly generation: number
  readonly projects: ReadonlyArray<ConfiguredProject>
  readonly project: (
    project: ConfiguredProject,
  ) => Effect.Effect<ProjectSnapshot, ProjectNotInSnapshot | SnapshotExpired>
}
```

### 4.3 `PlanApplication`

Public write-authority service. It is deliberately separate from Workspace so a planning or Verification runtime can omit write authority entirely.

```ts
interface PlanApplicationService {
  readonly apply: (
    verified: VerifiedPlan,
  ) => Effect.Effect<ApplicationReceipt, ApplicationError>
}
```

### 4.4 Internal services

`NativeCompiler` is an internal scoped technology service. It owns the spawned TypeScript process, snapshot acquisition/disposal, and transport-error translation. It must not leak raw process, client, or protocol values through the public API.

No separate public checker, emitter, query, cache, plan-builder, preview, or verifier service is permitted without new evidence that it owns a distinct authority or lifecycle. Queries, recipes, drafts, plans, previews, policies, evidence, and receipts are values or Effect-returning functions.

## 5. Provisional author-facing contract

The final naming and fluent shape are open for the API design session. The minimum operation set is:

```ts
Recipe.define(definition)
Recipe.run(recipe, input)

Query.nodes(project, nativeTypeGuard)
Query.calls(project)
Query.whereBatched(criterion)
Query.collect(query)

Plan.finalize(draft, capturedSnapshotInputs)
Plan.serialize(plan)
Plan.parse(serialized)

Verification.preview(plan)
Verification.verify(plan, recipeReplay)
Application.apply(verifiedPlan)
```

The executable facade probe shows that `Recipe.define` can preserve its input/error/requirement types and that `Query.calls` infers native `CallExpression`. Final API work may replace the namespace layout, but it must not lose those properties or introduce separate human and agent surfaces.

### Recipe execution contract

A production recipe definition contains:

- stable name and version;
- implementation hash supplied by the build/release process;
- a typed input;
- canonical serialization of options and declared environment inputs;
- an Effect program requiring `WorkspaceSnapshot` and any honest additional caller-provided service;
- explicit Plan Policies.

The recipe body should produce a Draft Plan rather than a finalized durable plan. The engine supplies captured workspace/toolchain inputs and performs finalization. This prevents recipes from forging snapshot evidence and allows idempotence Verification to rerun the transformation body, inspect an empty draft, and avoid incorrectly applying the primary-run cardinality policy to the no-op rerun.

The prototype recipes finalize directly; production implementation must move that responsibility into the engine.

## 6. Semantic Query contract

```ts
type Query<A, E = never, R = never> =
  Stream.Stream<Selection<A>, E, R>

interface Selection<A> {
  readonly value: A
  readonly projectId: string
  readonly fileName: string
  readonly canonicalFileName: string // live ordering only; never durable
  readonly start: number
  readonly end: number
  readonly evidence: ReadonlyArray<QueryEvidence>
}
```

- `A` is a native TypeScript node or semantic value.
- Native type guards must preserve exact inference.
- Query execution is ordinary Effect/Stream composition, not a serializable query AST.
- Every semantic criterion returns aligned optional evidence for its input batch; a length mismatch is a typed `QueryContractError`.
- Canonical collection sorts by project ID, normalized project-relative file, start, end, and a stable tie-breaker. Discovery timing never controls plan order.
- Semantic criteria use native array overloads where possible.
- Because decoded nodes may survive a generation while checker handles do not, cross-process semantic requests use stable file/position inputs when equivalent to sending a node handle.
- `Request` / `RequestResolver` is an internal coalescing option for independently composed lookups. A criterion already holding a batch calls the native array API directly.
- Query Evidence is deterministic. Timings, cache hits, traces, and batch sizes are metadata.

The Project Snapshot exposes an explicitly named `unsafeNative` callback. Its native values remain region-bound and cannot enter a durable Plan.

## 7. Snapshot input manifest

Staleness is defined by every input capable of changing recipe or compiler semantics, not merely edited files.

The native filesystem adapter records a canonical `SnapshotInputManifest` while planning:

```ts
type InputObservation =
  | { readonly _tag: "File"; readonly path: DurablePath; readonly hash: Sha256 }
  | { readonly _tag: "MissingFile"; readonly path: DurablePath }
  | { readonly _tag: "MissingDirectory"; readonly path: DurablePath }
  | { readonly _tag: "DirectoryEntries"; readonly path: DurablePath; readonly hash: Sha256 }
  | { readonly _tag: "Realpath"; readonly path: DurablePath; readonly target: DurablePath }

interface SnapshotInputManifest {
  readonly projects: ReadonlyArray<ProjectEvidence>
  readonly observations: ReadonlyArray<InputObservation>
  readonly toolchain: ToolchainIdentity
  readonly declaredEnvironment: Json
  readonly hash: Sha256
}
```

Successful reads are content-hashed. Negative file/directory probes and directory listings are evidence because creating a previously absent module can change resolution. Realpath/symlink observations are normalized. Built-in compiler libraries may be represented by the exact TypeScript distribution digest rather than repeated file entries, but third-party declarations and package-resolution inputs belong to the manifest.

The manifest probe proves the TypeScript 7 adapter observes read and resolution callbacks. The production recorder must prove completeness against package exports, path mapping, symlinks, project references, JSON modules, generated declarations, and missing-module creation before claiming full staleness coverage.

Durable paths use project/workspace-relative case-preserving text plus explicit project ID. Native canonical paths are live lookup/order keys only. Path comparison honors the host filesystem's case behavior; locale-dependent case conversion is forbidden.

## 8. Identity and evidence

Native `Node`, `Symbol`, `Type`, and `NodeHandle` identity is valid only within one snapshot region.

Durable node evidence is exact:

```ts
interface NodeAnchor {
  readonly projectId: string
  readonly fileName: string
  readonly start: number
  readonly end: number
  readonly kind: SyntaxKind
  readonly textHash: Sha256
}

interface SymbolAnchor {
  readonly name: string
  readonly flags: number
  readonly declarations: ReadonlyArray<NodeAnchor>
}
```

Re-resolution happens only after the complete input manifest matches. Project, file, range, kind, and text must match exactly. Nearby-text searching, silent refresh, and automatic rebasing are forbidden. A mismatch is `AnchorMismatch` or `StalePlan`, depending on whether manifest validation already failed.

## 9. Edit and source-fidelity contract

The sole durable edit primitive is:

```ts
interface TextEdit {
  readonly projectId: string
  readonly fileName: string
  readonly start: number
  readonly end: number
  readonly expectedTextHash: Sha256
  readonly newText: string
  readonly evidenceIds: ReadonlyArray<string>
}
```

- Replacement, insertion, and removal are forms of Text Edit.
- Rename, import management, templates, and compiler refactors are conveniences that compile to Text Edits.
- Finalization rejects invalid ranges, overlaps, inserts inside/on another range, and equal-position inserts.
- Edits sort by project, file, start, end, replacement text, and evidence ID.
- Application splices each file from the end toward the beginning.
- Every byte outside edited ranges remains identical.
- Node replacement defaults to `getStart(sourceFile)..getEnd()` and therefore preserves leading trivia. Widening the range is explicit.
- Native printing may produce a replacement fragment, never authorize whole-file printing.
- Removing comments inside an edited range is visible in Preview and never silently repaired.

Parsed templates and native refactor/code-fix conveniences are deferred because the current unstable async surface does not expose the required general parser/refactor APIs. Their eventual output must still be Text Edits.

## 10. Durable Transformation Plan

A finalized Plan is canonical JSON and contains only serializable data:

- schema version and content-derived Plan ID;
- recipe identity, implementation hash, canonical options, and declared environment;
- exact toolchain identity;
- stable project evidence;
- complete Snapshot Input Manifest and manifest hash;
- ordered Text Edits;
- Query/Plan Evidence and provenance linking every edit to an operation;
- Plan Policies and planning-time measurements.

The Plan ID is SHA-256 over canonical plan JSON excluding the ID field. Object keys and set-like arrays are canonicalized. Absolute workspace path, wall-clock time, process ID, scheduling, trace data, temporary names, and performance measurements cannot affect identity.

The Plan contains no native values, handles, functions, Effects, services, open resources, or random identifiers. Deserialization validates the schema and recomputes Plan ID before returning a typed plan.

## 11. Policies and invariants

### Non-disableable invariants

1. Only Application writes.
2. Identical declared inputs, recipe, options, environment, and toolchain produce an identical Plan and exact output bytes.
3. A finalized Plan has no ambiguous edit order.
4. Stale inputs are rejected; never rebased implicitly.
5. Failure never returns a usable partial Plan.
6. Application requires successful Verification against the same manifest.
7. Unedited bytes and files remain unchanged.
8. Success is reported only after all outputs are confirmed.
9. Handled write failure rolls back; failed rollback is indeterminate.

### Plan Policies

- exact/minimum/maximum/ranged match count;
- allowed/excluded paths and maximum affected files;
- complete diagnostic-delta policy, defaulting to no new error diagnostics;
- declared idempotence, normally required for production codemods;
- explicit opt-out for unconstrained dimensions.

The engine evaluates primary-run cardinality after recipe evaluation. During idempotence replay it runs the recipe body against proposed state and requires an empty Draft Plan; it does not demand that primary-run match minima remain true.

## 12. Preview and Verification

### Preview

Preview revalidates the manifest, validates guarded old ranges, computes exact outputs in memory, and returns before/after hashes and bytes. It performs no writes. A dry run is Preview plus Verification.

### Verification

Verification starts with a fresh compiler authority over a complete virtual filesystem containing proposed outputs and original untouched inputs. The correctness baseline is a fresh TypeScript process; cache reuse may be introduced only with a conformance proof that it cannot retain planning-generation nodes or handles.

Verification must:

1. revalidate plan/schema/toolchain/manifest;
2. parse and configure every proposed project;
3. compute complete normalized baseline and proposed diagnostics;
4. evaluate all policies;
5. rerun the same recipe identity and input when idempotence is required;
6. require the replay Draft Plan to contain zero edits;
7. return a process-local Verified Plan and durable Verification Receipt.

Diagnostics are normalized to stable project-relative paths and stable fields. Counts alone are insufficient in production. Timing and trace metadata are separate.

## 13. Application and recovery

Application receives only a Verified Plan. Immediately before staging it revalidates the complete semantic input manifest, including unrelated files and negative resolution observations. It then rechecks each guarded range, computes all outputs, and stages all files before replacing the first target.

The initial implementation uses same-filesystem temporary files and per-file atomic rename. It retains original bytes until completion and rolls back already replaced files after a handled failure.

Outcomes:

- `ApplicationReceipt`: all output hashes confirmed;
- `ApplicationFailure`: no final success, rollback completed;
- `ApplicationIndeterminate`: rollback failed; contains recovery evidence.

Multi-file process/power-loss atomicity is explicitly unclaimed. A later durable journal must define prepare, commit, recovery discovery, idempotent replay, and cleanup before that guarantee changes.

## 14. Error model

Expected failures are typed tagged errors. Defects are reserved for broken internal invariants.

| Phase | Required error families |
| --- | --- |
| Configuration/lifecycle | `DuplicateConfiguredProject`, `ProjectNotInSnapshot`, `SnapshotExpired`, `NativeCompilerError` |
| Query | `QueryContractError`, typed native semantic failures |
| Recipe | recipe-specific ambiguity/conflict errors such as `RenameConflict` |
| Finalization | invalid range, edit conflict, duplicate/missing evidence, missing manifest source, non-serializable input |
| Decode | invalid JSON, unsupported schema, Plan ID mismatch |
| Preview | `StalePlan`, guarded-source mismatch, edit validation failure |
| Verification | policy failure, diagnostic regression, replay mismatch, toolchain mismatch |
| Application | `StalePlan`, `ApplicationFailure`, `ApplicationIndeterminate` |

Errors contain stable domain evidence, not only messages. Native/protocol causes may be attached as non-deterministic diagnostic detail but do not enter Plan identity.

## 15. Internal architecture

Recommended production modules:

```text
src/
  domain/
    project.ts                 ConfiguredProject and WorkspaceDefinition values
    evidence.ts                durable evidence and anchors
    policy.ts                  Plan Policy values/results
  compiler/
    native-compiler.ts         internal scoped TypeScript process adapter
    input-recorder.ts          complete FS/resolution observation recorder
    path-identity.ts           native/durable path boundary
  workspace/
    workspace.ts               public Workspace service and snapshots
  query/
    query.ts                   Query, Selection, combinators
    semantic-criteria.ts       generic native batching primitives
  recipe/
    recipe.ts                  recipe identity/definition/execution contract
    draft-plan.ts              operation-local immutable/mutable builder choice
  plan/
    edit.ts                    guarded Text Edit and conflict validation
    plan.ts                    canonical durable schema and codec
  verification/
    preview.ts                 pure/read-only output materialization
    verify.ts                  isolated virtual compiler orchestration
  application/
    application.ts             application-owned port/tag and policy
    node-filesystem.ts         production filesystem adapter and staging
  testing/
    fixtures.ts                honest local configured-project fixtures
```

Dependencies point inward: domain and plan modules do not import the compiler adapter. Workspace and Verification depend on the internal compiler port. The filesystem application adapter implements the application-owned port. A composition root chooses Layers.

## 16. Concurrency, batching, caching, and tracing

- Snapshot generation creation is serialized per Workspace.
- Independent snapshot regions and project/file work use structured concurrency with explicit bounds.
- File traversal is streaming; deterministic collection occurs only at plan boundaries.
- Native array overloads are the default IPC batching mechanism.
- Request/Resolver coalescing is used only for independently composed lookups and is not assumed to deduplicate equal requests.
- Native decoded source, symbol, and type caches are valid only under their proven snapshot/client lifetime.
- Any userland semantic cache is snapshot-local and keyed by stable live identity; it never enters a durable artifact.
- Named Effects trace compiler operations, snapshot transitions, query criteria, finalization, Verification, and Application.
- Trace IDs, timings, memory, scheduling, cache hits, and batch sizes are operational metadata.

## 17. Test strategy and release gates

### Unit/property suites

- canonical JSON and Plan ID stability under reordered inputs;
- edit ordering, overlap/insert conflicts, reverse application, and unchanged-byte properties;
- durable path normalization across case behavior, separators, symlinks, and workspace relocation;
- manifest hashing including positive and negative resolution observations;
- schema decode/tamper rejection;
- policy boundary tables.

### Native integration suites

- process acquisition/disposal and snapshot expiry;
- changed/unchanged source-node behavior across generations;
- symbol/type identity scope;
- scalar versus array checker parity;
- retained-node/new-checker stale-handle regression;
- complete filesystem observation under module-resolution variants;
- native hybrid fragment printing;
- multiple configured projects and project references.

### Recipe conformance matrix

- semantic call rewrite through aliases/re-exports;
- import migration with quote/comment/trivia preservation;
- canonical-symbol rename with direct, aliased, re-exported, and same-text unrelated identifiers;
- ambiguity failure without partial plan;
- unchanged pre-existing diagnostics;
- diagnostic regression rejection;
- idempotence replay;
- workspace change after planning and after Verification;
- successful and injected-failure multi-file Application.

### Type tests

- native type guards infer exact node types;
- criteria preserve candidate types and typed errors/requirements;
- recipe input/error/requirement inference survives `define` and `run`;
- Application requires the Verified Plan brand;
- raw Plans cannot be passed to Application;
- multi-project inputs do not collapse to a singleton type.

### Release gate

Every supported TypeScript version runs all type, unit, native integration, and recipe suites. No upgrade ships on version strings alone.

## 18. Staged implementation plan

### Stage 1 — semantic kernel

1. Move prototype domain types into production modules.
2. Give Configured Projects explicit durable IDs and separate runtime absolute paths.
3. Implement path identity without locale-dependent normalization.
4. Implement Text Edit validation/application and canonical Plan schema with Effect Schema or an equivalently complete runtime codec.
5. Preserve all existing property/type tests.

Exit: plans are relocatable, canonical, strictly decoded, and source-fidelity tests pass.

### Stage 2 — workspace and manifest

1. Harden NativeCompiler and Workspace scoped Layers.
2. Implement the filesystem/resolution recorder and complete Snapshot Input Manifest.
3. Add project references and multiple configured-project integration fixtures.
4. Prove manifest invalidation for file content, missing-file creation, package exports, path aliases, symlinks, configuration, and external declarations.

Exit: any tested semantic input change produces a different manifest or a typed unsupported-input failure.

### Stage 3 — query and recipe engine

1. Stabilize Query/Selection/Evidence and generic batched criteria.
2. Make engine-owned finalization consume recipe-produced Draft Plans.
3. Add primary-run policy measurement separate from idempotence replay.
4. Retain native escape hatch and snapshot expiry checks.

Exit: the three representative recipes use only production core primitives and retain type inference.

### Stage 4 — isolated Verification

1. Build complete virtual filesystem overlays from Preview.
2. Start a fresh compiler authority and collect normalized full diagnostic deltas.
3. Replay recipes for idempotence.
4. Produce durable Verification Receipts and process-local Verified Plans.

Exit: no write capability is present and the complete recipe matrix verifies.

### Stage 5 — Application and recovery

1. Implement the application-owned filesystem port and production adapter.
2. Revalidate the full manifest immediately before staging.
3. Stage all outputs, rename, confirm hashes, and roll back handled failures.
4. Add fault-injection tests for every write/rename/rollback position.

Exit: no false success or silent partial outcome is possible under handled failures.

### Stage 6 — public API design and hardening

1. Use the semantic contract and conformance tests to compare authoring shapes.
2. Optimize names, pipelines, draft ergonomics, and construction helpers without weakening inference or invariants.
3. Add import/rename/template conveniences only above the kernel.
4. Benchmark very large repositories and tune batch/concurrency defaults.

Exit: the project owner accepts the public API, representative recipes remain elegant, and performance budgets are documented.

## 19. Known gaps that must remain visible

- Prototype plans fingerprint project-owned sources and configuration, not yet the complete resolution manifest specified here.
- Prototype decode validation is shallow; production requires a complete runtime schema.
- Prototype Verification records diagnostic counts; production requires normalized diagnostic identities and deltas.
- Prototype recipes finalize their own Plan; production finalization belongs to the engine.
- Prototype destination-conflict checking is recipe-specific and intentionally incomplete.
- Prototype multi-file rollback logic is not yet fault-injected at every boundary.
- Project references and external declaration resolution are modeled but not yet proven end to end.
- Parsed syntax templates and native refactor APIs remain deferred.
- Public names in the facade probe are candidates, not an accepted aesthetic design.

These are implementation tasks or explicit deferrals, not hidden guarantees.

## 20. Evidence index

| Contract area | Primary executable evidence |
| --- | --- |
| Native process/snapshot lifecycle | `native-lifecycle.ts` / `.test.ts` |
| Multi-project snapshot shape | `workspace-snapshot.ts` / `.test.ts` |
| Semantic Query and inference | `semantic-query.ts` / `.test.ts` |
| Request coalescing comparison | `semantic-request.ts` / `.test.ts` |
| Native versus durable identity | `identity.ts` / `.test.ts` |
| Minimal edits and fragment printing | `edits.ts` / `.test.ts` |
| Canonical durable Plan | `plan.ts` / `.test.ts` |
| Preview/Application/staleness | `verification.ts` / `.test.ts` |
| Complete vertical slice | `wrap-target-recipe.ts` / `end-to-end.test.ts` |
| Import/symbol stress matrix | `stress-recipes.ts` / `.test.ts` |
| Facade composition and type inference | `public-api-probe.ts` / `.test.ts` |
| Manifest-observation feasibility | `snapshot-manifest.test.ts` |

The Wayfinder issues remain the rationale record. This artifact is the production handoff contract derived from them.
