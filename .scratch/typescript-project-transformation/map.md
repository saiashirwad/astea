# Design a reliable TypeScript project transformation system

## Destination

Produce an implementation-ready specification, anchored by a working proof of concept, for an elegant Effect-native API that lets agents and human codemod authors query a configured TypeScript 7 project, produce deterministic and inspectable Transformation Plans, verify their consequences, and explicitly apply minimal edits. The design must not preclude multiple configured projects or project references, but production infrastructure is not part of this effort.

## Notes

- Primary users are agents, followed by human codemod authors; both use the same API.
- The public orchestration model is Effect v4. Immutable domain values should remain ordinary TypeScript data where practical.
- Prototype against `typescript/unstable/async`, a spawned TypeScript 7 process, and a filesystem-backed configured project.
- Begin with one configured project, while rejecting domain and API choices that inherently assume one project or one `tsconfig`.
- `ts-macros` is an independent source of inspiration only. Its rules, implementation and product boundary do not govern this project.
- Use the `grilling` and `domain-modeling` skills for decision tickets. Use the `prototype` skill for concrete API and behavior experiments.
- The TypeScript API baseline comes from Andrew Branch's thread: https://bsky.app/profile/andrewbran.ch/post/3mt3limebfc2h
- Preserve and consult the unratified [initial design synthesis](./briefing/initial-design-synthesis.md). It is source material for decisions, not an accepted specification.

## Decisions so far

<!-- Closed decision tickets are indexed here. -->

- [Review the initial design synthesis](./issues/13-review-the-initial-design-synthesis.md) — Established the product constraints and routed unproven query, construction, batching, reliability, and proof-of-concept ideas to focused decisions and experiments.
- [Establish the proof-of-concept harness](./issues/01-establish-the-proof-of-concept-harness.md) — Pinned a passing Effect 4/TypeScript 7 harness and proved the native async API can inspect a filesystem-backed configured project.
- [Define the reliability contract](./issues/02-define-the-reliability-contract.md) — Separated non-disableable invariants from explicit plan policies and advisory metadata, defining deterministic, stale-safe, verified, conflict-free, and failure-honest transformations.
- [Prototype the native project lifecycle](./issues/03-prototype-the-native-project-lifecycle.md) — Proved scoped overlapping snapshots, snapshot-local semantic identity, source-buffer reuse, virtual overlay updates, native batching, hybrid printing, timing, and disposal constraints.
- [Choose the project and snapshot domain model](./issues/04-choose-the-project-and-snapshot-domain-model.md) — Selected a region-scoped Effect hierarchy where a Workspace creates immutable multi-project Workspace Snapshots containing explicit Project Snapshot views.
- [Choose the semantic query and selection model](./issues/05-choose-the-semantic-query-and-selection-model.md) — Selected Effect Streams of native, evidence-bearing Selections with batched semantic criteria, deterministic collection, and an explicit unsafe native escape hatch.
- [Choose node and symbol identity across snapshots](./issues/06-choose-node-and-symbol-identity.md) — Kept native identities snapshot-bound and selected strict, serializable node and symbol anchors as plan evidence, with stale inputs rejected rather than rebased.
- [Choose the edit and source-fidelity model](./issues/07-choose-the-edit-and-source-fidelity-model.md) — Selected guarded minimal text edits as the sole plan primitive, with deterministic ordering, strict conflict rejection, byte preservation outside edited ranges, and native printing for synthesized fragments.
- [Choose the Effect service and batching model](./issues/08-choose-the-effect-service-and-batching-model.md) — Kept lifecycle and authority in three narrow Effect capabilities, left domain descriptions as values, and reserved Request/Resolver batching for independently composed internal lookups.
- [Decide Transformation Plan durability and evidence](./issues/09-decide-plan-durability-and-evidence.md) — Made finalized plans canonical, content-addressed JSON artifacts while keeping live draft state and compiler/filesystem authority process-local.
- [Choose verification and application semantics](./issues/10-choose-verification-and-application-semantics.md) — Separated deterministic preview, isolated virtual Verification, and stale-safe explicit Application with staged writes, typed recovery outcomes, and durable receipts.
- [Prove one end-to-end Transformation Recipe](./issues/11-prove-one-end-to-end-recipe.md) — Proved an alias-aware, comment-preserving, idempotent API migration through semantic query, durable plan, virtual diagnostics, and explicit two-file application.
- [Stress-test the API with representative Transformation Recipes](./issues/14-stress-test-the-api-with-representative-recipes.md) — Reused the core for call, import, and symbol recipes; proved ambiguity, baseline-diagnostic, idempotence, trivia, and post-verification staleness behavior; kept operation conveniences outside the kernel.
- [Shape the implementation-ready specification](./issues/12-shape-the-implementation-ready-specification.md) — Produced the production handoff contract, provisional facade/type probe, complete-manifest feasibility probe, internal architecture, compatibility/error policy, test gates, and staged implementation plan.

## Not yet specified

- How transformations coordinate across multiple configured projects and project references; this should become precise after the single-project domain model is proven.
- What realistic performance and memory budgets should define success for very large repositories; this depends on baseline instrumentation from the native lifecycle and vertical-slice prototypes.
- Whether collaboration requires rebase, merge, or distributed-plan semantics beyond detecting a stale plan; this depends on the chosen identity and durability models.

## Out of scope

- TypeScript 6 and older compiler APIs.
- Production CLI, MCP server, editor extension, deployment and distribution infrastructure.
- Sandboxing arbitrary TypeScript authored outside the transformation capability boundary.
- A production catalogue of framework migrations or parity with every ts-morph convenience API.
- Folding this project into `ts-macros` or evolving `ts-macros` through this effort.
