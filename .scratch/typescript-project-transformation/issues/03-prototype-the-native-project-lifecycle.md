# Prototype the native project lifecycle

Type: prototype
Status: resolved
Blocked by: 01

## Comments

- Claimed to test an Effect-scoped native compiler authority seam and the actual validity rules of TypeScript 7 snapshots and their remote objects.
- Implemented the experiment in `src/prototype/native-compiler.ts` and `src/prototype/native-lifecycle.ts`, with a real local compiler process and filesystem fixture rather than a protocol fake.

## Question

What lifecycle and capability constraints does `typescript/unstable/async` impose when a spawned TypeScript 7 process opens a real filesystem-backed configured project, produces immutable snapshots, observes file changes, queries semantics, prints transformed fragments, and constructs a virtual next state? Build the smallest concrete experiment that exposes timings, disposal requirements, identity behavior, batching opportunities, and missing APIs.

## Answer

The native compiler connection is a genuine Effect service seam. It owns an external process, connection state, snapshot acquisition, nested resource lifetimes, timing instrumentation, and cleanup. The prototype therefore gives `NativeCompiler` a scoped production `Layer`; `openSnapshot` itself requires an Effect `Scope`, so snapshots are disposed before the compiler connection closes. A failure-path test proves an acquired snapshot is finalized when its owning Effect scope fails.

Project paths, update parameters, lifecycle reports, native AST values, and the promise-to-Effect conversion helper remain ordinary values. There is no fake or in-memory service Layer: a fake would not preserve the protocol, binary AST, cache, identity, or disposal behavior this seam exists to own. The real bundled local compiler and an isolated fixture are the honest test implementation. There is no `layerWithoutDependencies` because this adapter currently has no Effect requirements to preserve; `layer(options)` is already the complete assembly.

The service currently exposes raw native `Snapshot` values only to conduct the experiment. That is explicitly not a proposed public API. A product API must prevent semantic work from escaping its Project Snapshot authority, while still using native TypeScript nodes rather than inventing a parallel hierarchy.

### Observed lifecycle

- `API` lazily spawns/initializes on its first request and may hold multiple active snapshots.
- Consecutive snapshots receive distinct numeric IDs. Creating a new snapshot does not invalidate an older active snapshot; the older program remains semantically queryable until explicitly disposed.
- `API.close()` disposes every still-active snapshot before closing the client. The Effect Layer finalizer owns this operation, while each nested snapshot scope calls `Snapshot.dispose()` independently.
- The compiler Layer's scope must strictly enclose every snapshot scope. Letting a snapshot register in a broader ambient scope than the Layer allows connection teardown to race snapshot release on failure. The prototype composes an explicit nested snapshot scope and verifies its finalizer on the failure path; the eventual API should make this ordering difficult or impossible to misuse.
- A disposed `Snapshot` synchronously rejects its own accessors. Remote calls made through its retained `Program` fail because the server generation has been released.
- Decoded AST buffers remain locally readable after snapshot disposal, and the emitter can still encode and print a decoded node while the compiler connection remains open. Therefore the native object's continued JavaScript usability is not evidence that semantic access is valid.

### Identity and caching

- Repeating a symbol lookup within one snapshot returns the same `Symbol` object. A batched lookup containing the same position twice also returns the same object twice.
- Repeating a type lookup within one snapshot returns the same `Type` object.
- Corresponding symbols and types from a later snapshot are different JavaScript objects.
- A changed source file receives a different `SourceFile` object in the next snapshot.
- An unchanged source file may retain exactly the same `SourceFile` object across snapshots through the client's binary source cache.

Consequently, reference equality is useful only within a declared snapshot authority. It cannot serve as persistent identity or as proof that two values have the same lifetime. Snapshot-bound identity must be a semantic rule imposed by this project, not inferred from native wrapper allocation.

### Filesystem and virtual next state

The experiment starts with a real filesystem-backed `tsconfig.json`. It installs only a synchronous `readFile` override in the native API's filesystem callback and otherwise falls back to the real filesystem. After placing changed source text in that overlay, `updateSnapshot({ fileChanges: { changed: [...] } })` creates a new checked generation with one new semantic error. The original disk file remains byte-for-byte unchanged and the older snapshot continues to report zero errors.

This is enough to construct a virtual proposed state without writing project files. However, `updateSnapshot` accepts invalidation metadata, not file contents; overlay content must already be available through the API-wide synchronous filesystem callbacks. The eventual verification adapter must therefore own a coherent overlay plus change notification rather than treating snapshot creation as a self-contained value call.

### Batching, printing, and timing

- Two scalar symbol-position lookups produce two measured native requests.
- The equivalent array overload produces one measured native request and preserves result order and identity.
- The native emitter successfully prints a hybrid variable statement composed of remote children and a synthesized numeric literal as `export const answer = 43;`.
- Built-in timing collection reports request count, bytes, server and transport time, fetched source files, total fetchable nodes, and lazily materialized nodes. Timing resets are global to the compiler client, so reports must name their measurement window rather than present reset counters as whole-run totals.

This proves array-call batching is materially real. It does not yet prove Effect `Request` / `RequestResolver` is the right authoring or execution abstraction.

### Missing or constrained capabilities

- No native request in the exercised public surface accepts an `AbortSignal`, so Effect interruption cannot currently cancel an individual in-flight compiler request through the public API.
- Snapshot change details are used internally for cache retention but are not exposed on the public `Snapshot` object.
- There is no content-bearing virtual-update parameter; callers coordinate filesystem overlays and invalidation separately.
- Native snapshot disposal guards the `Snapshot` entrypoints, but not every retained project, program, checker, emitter, or decoded node with an eager local lifetime check.
- The API does not expose a durable snapshot identity or content fingerprint suitable for a Transformation Plan. The project must construct deterministic snapshot evidence above the native numeric generation ID.

### Service-design disposition

Keep the native compiler connection as a scoped technology service. Keep snapshot acquisition scoped beneath it and make the compiler-before-snapshot finalizer ordering structural rather than conventional. Do not create services for domain values or wrap each AST/compiler type. Do not expose the raw native snapshot from the eventual public transformation API. Do not add a test Layer that pretends to implement native semantics; continue using isolated real projects for lifecycle and protocol tests. Defer the exact domain-shaped snapshot capability to the project/snapshot model ticket now that these constraints are proven.
