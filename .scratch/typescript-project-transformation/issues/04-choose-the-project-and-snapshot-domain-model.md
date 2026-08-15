# Choose the project and snapshot domain model

Type: prototype
Status: resolved
Blocked by: 02, 03

## Comments

- Claimed to compare mutable, raw-scoped, and region-scoped API shapes against the proven native lifecycle, then select a domain model that treats multiple configured projects as normal.
- Implemented the selected model in `src/prototype/workspace-snapshot.ts` and exercised single-project, multi-project, transition, concurrent-region, and expired-capability scenarios against the real native compiler.

## Question

What domain model should represent a workspace, configured projects, immutable compiler snapshots, and transitions between snapshots? Prototype competing API shapes and choose one that is elegant for a single configured project without encoding assumptions that prevent future multi-project and project-reference coordination.

## Answer

Use a region-scoped Effect model centred on a workspace-wide generation.

- A **Workspace** is a non-empty, stable set of Configured Projects and the authority that creates successive checked generations.
- A **Configured Project** is immutable plain data identifying a TypeScript configuration file. It remains stable across generations and is not a service or a native compiler object.
- A **Workspace Snapshot** is the immutable native generation shared by every project in the Workspace.
- A **Project Snapshot** is the checked view of one Configured Project inside that Workspace Snapshot.
- A **Snapshot Transition** creates the next Workspace Snapshot from declared file or project changes. It does not mutate the earlier generation, which may remain active concurrently.

This corrects an important single-project bias in the initial vocabulary: the native TypeScript snapshot is workspace-wide and can contain several configured projects. A Project Snapshot is a member view, not the top-level generation.

### Shapes considered

#### Mutable workspace object

```ts
workspace.openProject(config)
const snapshot = await workspace.snapshot()
snapshot.update(changes)
```

Rejected. It introduces an implicit “current” generation, makes mutation and transition easy to conflate, encourages long-lived project wrappers, and tends to grow single-project conveniences that become coordination problems later.

#### Raw scoped acquisition

```ts
const snapshot = yield* workspace.openSnapshot(changes)
```

Rejected as the public shape. Although the `Scope` requirement is visible in the Effect type, a caller can register the snapshot in a scope that outlives the compiler Layer. The lifecycle prototype reproduced a shutdown race from precisely this wrong nesting. It also makes returning raw snapshot capabilities from the scope too easy.

#### Callback argument region

```ts
workspace.withSnapshot(changes, (snapshot) => recipe(snapshot))
```

Viable but not selected as the core Effect shape. It enforces resource nesting, but causes snapshot parameters to be threaded through every reusable query and recipe helper.

#### Effect context region

```ts
Workspace.use((workspace) =>
  workspace.withSnapshot(changes, Effect.gen(function*() {
    const snapshot = yield* WorkspaceSnapshot
    const project = yield* snapshot.project(configuredProject)
    return yield* project.semanticDiagnosticCount()
  }))
)
```

Selected. Reusable operations state `WorkspaceSnapshot` in their Effect requirements, and `withSnapshot` discharges that requirement for the bounded region. The Workspace implementation, rather than every caller, owns exact compiler-before-snapshot finalizer ordering. A runtime lease rejects semantic operations after the region with typed `SnapshotExpired`; native projects, programs, checkers, and emitters do not cross the adapter boundary.

The syntax above is the tested prototype, not final naming. A later API pass may add a more fluent or static combinator, but there should remain one semantic operation for entering a snapshot region rather than separate agent, human, single-project, or multi-project APIs.

### Service and value boundaries

`Workspace` is an application service because it owns transition policy, serialization, region lifetime, and the set of configured projects. It depends on the technology-specific `NativeCompiler` service. The prototype exposes both `layerWithoutDependencies`, which preserves the `NativeCompiler` requirement, and `layer`, which assembles the native production adapter.

`WorkspaceSnapshot` is an operation-scoped context capability, not a long-lived Layer. `ConfiguredProject`, `SnapshotTransition`, and returned project metadata are values. `ProjectSnapshot` is a region-bound capability value whose methods close over the native project without exposing it.

No reusable fake Layer is appropriate: snapshot membership, checking, cache behavior, and lifetime are protocol semantics. Tests use real isolated configured projects and the bundled native compiler.

### Proven behavior

- The same API opens one or multiple Configured Projects; the multi-project fixture opens two independent `tsconfig.json` files in one generation.
- A Configured Project is selected explicitly even when the Workspace contains only one, so no “default project” assumption enters the domain model.
- A transition produces a new generation and different diagnostics without changing the older result.
- A project capability that escapes its region fails with `SnapshotExpired` before making a native request.
- A semaphore serializes only native generation creation. Effects using earlier and later immutable snapshots can overlap concurrently.
- Duplicate Configured Projects are rejected when constructing the Workspace.

### Deliberately open details

- The prototype uses an absolute normalized configuration path as runtime project identity. Durable, root-independent project identity belongs with Transformation Plan evidence and is not settled here.
- Project-reference discovery and graph metadata are not implemented, but a Workspace already contains an arbitrary non-empty project set and a generation already coordinates them together.
- The eventual semantic-query API will determine how native nodes are exposed without exposing native checker authority. No parallel AST hierarchy is introduced here.
- Transition concurrency currently has a deterministic generation order, but the policy for competing virtual overlays belongs to Verification and Application.
- Final combinator names and call-site sugar remain open for the API-shaping pass.

### Decision

Adopt Workspace → Workspace Snapshot → Project Snapshot as the domain hierarchy. Use an Effect context region to authorize snapshot-scoped work. Keep Configured Project identity as plain data, make Snapshot Transition a Workspace operation, serialize generation creation, and permit immutable generations to be queried concurrently.
