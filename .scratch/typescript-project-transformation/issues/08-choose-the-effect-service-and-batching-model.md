# Choose the Effect service and batching model

Type: prototype
Status: resolved
Blocked by: 03, 04, 05

## Comments

- Claimed to audit the service hierarchy and compare Effect Request batching with the query engine's direct native array calls.

## Question

How should Effect v4 represent the compiler connection, workspace capabilities, snapshot scope, semantic failures, tracing, caching, and batched IPC? Prototype `Context.Service`, scoped Layers, and `Request` / `RequestResolver` against TypeScript's scalar and array checker operations, then choose the smallest coherent public service boundary.

## Answer

The smallest coherent public hierarchy has three Effect capabilities already proven by the workspace prototype:

- `NativeCompiler` is the scoped technology service that owns the spawned TypeScript process and converts rejected native promises into `NativeCompilerError`.
- `Workspace` is the application service and concurrency authority. It serializes creation of native generations and introduces snapshot regions.
- `WorkspaceSnapshot` is a region-provided capability; it yields plain `ProjectSnapshot` capability values and expires them when the region ends.

Semantic Queries, Selections, recipes, draft/final plans, edits, and evidence remain ordinary values or Effects parameterized by these capabilities. There will not be separate public checker, emitter, cache, query, or plan-builder services. This follows the Effect service-design boundary: services represent lifecycle or authority seams, not every collection of functions.

Effect's `Request` / `RequestResolver` is viable as an internal batching mechanism. The prototype proves three independently composed symbol lookups are coalesced into one resolver wave and one native array checker call, preserving result identity. In the pinned Effect 4 release candidate, two structurally equal tagged requests were both present in the batch, so no implicit deduplication guarantee is assumed. Explicit snapshot-local memoization can be added only when measurements justify it.

The public Query API does not expose Requests. A query criterion that already owns a candidate batch should call the native array overload directly, avoiding an extra abstraction. Requests are useful internally when separate effects cannot otherwise see each other and coalescing materially reduces IPC. Both paths produce the same typed semantic failures and Query Evidence.

Named `Effect.fn` boundaries provide tracing for compiler operations, snapshot transitions, queries, verification, and application. Timing, batch size, cache hits, and trace IDs are operational metadata rather than deterministic Plan Evidence. Native decoded-object caches and any semantic cache are scoped no longer than the compiler/snapshot authority that validates their values.

Prototype: [`src/prototype/semantic-request.ts`](../../../src/prototype/semantic-request.ts) and [`src/prototype/semantic-request.test.ts`](../../../src/prototype/semantic-request.test.ts). The service audit also covers [`src/prototype/native-compiler.ts`](../../../src/prototype/native-compiler.ts) and [`src/prototype/workspace-snapshot.ts`](../../../src/prototype/workspace-snapshot.ts).
