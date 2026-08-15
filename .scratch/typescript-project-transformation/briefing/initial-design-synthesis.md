# Initial design synthesis

Status: unratified design seed

This document preserves the initial synthesis that combined Andrew Branch's TypeScript 7 API thread, the ts-morph model, ideas from `ts-macros`, Effect v4, and agent-oriented transformation requirements. Nothing here is accepted architecture merely because it appears in this document. Each proposition must be accepted, reshaped, deferred to a prototype, or rejected through the Wayfinder map.

## Source observations

### What the TypeScript 7 API changes

Andrew Branch's [thread](https://bsky.app/profile/andrewbran.ch/post/3mt3limebfc2h) demonstrates a native TypeScript API with synchronous and asynchronous clients under `typescript/unstable/*`.

- The compiler runs in a separate native process, with API calls travelling over an IPC channel.
- Programs are accessed as immutable snapshots rather than one mutable, long-lived compiler object.
- Source files cross the process boundary as compact binary ASTs.
- JavaScript sees lazy facades over that buffer; child nodes materialize only when accessed.
- Node specialisation largely exists at the TypeScript type level while runtime nodes share an implementation.
- Symbols and types are cached so repeated semantic queries preserve reference identity within their valid lifetime.
- A transformed tree may combine remote nodes backed by the binary buffer with newly synthesized JavaScript nodes, then be encoded and sent to the native emitter.
- A future or alternate connection may attach to an editor's already-running TypeScript LSP through a sidecar session.

The binary representation was inspired by Marvin Hagemeister's [Deno plugin work](https://marvinh.dev/blog/speeding-up-javascript-ecosystem-part-11/): flatten the tree, represent relationships as indices, and expose lazy typed facades rather than deserializing a huge JavaScript object graph.

The initial conclusion was that TypeScript is becoming usable as a compiler database or service, rather than only a JavaScript library exposing an in-process object graph.

### What this suggests about ts-morph

ts-morph wraps compiler nodes in a rich mutable object model: navigate through getters, mutate through node-specific methods, and eventually save the project. That model was a major usability improvement over the historical compiler API, but it carries costs that become especially visible for agents and snapshot-based compilers.

- It requires an elaborate wrapper surface for most syntax kinds.
- Mutation can invalidate or “forget” previously held nodes.
- Reads, mutations, project state, formatting, and persistence are entangled.
- There is no first-class transaction, verified diff, policy boundary, or provenance model.
- Long-lived wrapper identity obscures the fact that compiler generations have changed.
- Agents cannot naturally present a complete proposed operation before it occurs.

The resulting hypothesis was: do not build “ts-morph backed by tsgo.” The new abstraction should be transactional and snapshot-oriented rather than a modernized mutable AST object graph.

### What `ts-macros` contributes

`ts-macros` is generative: it constructs typed programs as data and emits a new program. This project is transformational: it must understand and alter an existing checked project while preserving source identity. They are separate projects, but several ideas may transfer.

Candidate ideas to borrow:

- Immutable discriminated program data.
- Phantom-typed expressions such as `Expr<A>`.
- Yieldable or pipeable builders that return typed references.
- A representation that remains inspectable before execution or emission.
- Separation between semantic representation and backend.
- Preservation of unresolved type information instead of replacing TypeScript's own type reasoning with a parallel userland checker.

Candidate ideas not to borrow directly:

- Name-based references for existing source; compiler symbol or snapshot identity is required.
- A custom type algebra as the semantic authority; the TypeScript checker should remain authoritative.
- Babel as the transformation backend.
- A hand-maintained custom wrapper or IR node for every TypeScript syntax kind.

One possible later relationship is for a typed construction DSL to produce synthesized replacement fragments. That does not make the two projects part of the same product or umbrella.

## Initial architectural hypothesis

The proposed centre of gravity was a typed transaction layer over TypeScript snapshots:

```text
native TypeScript process or editor LSP
                 ↓
         immutable Snapshot
                 ↓
      semantic Query execution
        (batched and cached)
                 ↓
      inspectable Transformation Plan
                 ↓
 conflict, policy, and diagnostic verification
                 ↓
             preview Diff
                 ↓
       explicit atomic application
                 ↓
          next immutable Snapshot
```

The suggested domain objects were:

- **Workspace**: owns access to configured projects and the native compiler connection.
- **Snapshot**: an immutable checked view of a workspace or configured project generation.
- **Anchor<K>**: a snapshot-aware reference to a node or symbol.
- **Query<A>**: a description of what to find, ideally capable of semantic selection.
- **Fragment<K>**: parsed or synthesized replacement syntax of a known category.
- **Transformation Recipe**: reusable code that queries a project and produces a plan.
- **Transformation Plan**: an inspectable set of proposed edits against a particular snapshot.
- **Receipt**: evidence of preview, verification, or application, potentially including diagnostics and provenance.

These names were proposals. Only Project Transformation System, Transformation Recipe, and Transformation Plan have since entered the glossary.

## Initial Effect v4 hypothesis

Effect v4 appeared to match the operational shape of the native compiler API.

- `Context.Service` could define compiler, workspace, filesystem, formatter, and policy capabilities.
- Scoped Layers could own the spawned TypeScript process and snapshot disposal.
- Typed failures could distinguish stale anchors, ambiguous matches, compiler transport failures, edit conflicts, and verification failures.
- Tracing could connect compiler requests and output hunks to the recipe operation that caused them.
- Structured concurrency could coordinate independent files or configured projects.
- In-memory or fixture Layers could support repeatable tests.

The strongest proposed connection was Effect's `Request` / `RequestResolver`. TypeScript 7 already exposes array overloads for several semantic checker operations. Semantic lookups could become Effect requests that are deduplicated and batched into fewer IPC calls.

The initial slogan for this relationship was:

> Effect requests are the query planner; the native TypeScript compiler is the execution engine.

This remains a prototype hypothesis, not a settled service design.

## Initial public API hypotheses

### Separate reading, planning, verification, and writing

The proposed workflow separated each stage:

- Querying does not mutate.
- Planning does not write.
- Verification applies a plan to a virtual next state.
- Preview produces an inspectable diff and evidence.
- Application requires an explicit write capability.

This separation was intended to support review, policy checks, resumption, replay, dry runs, and agent approval boundaries.

### Prefer semantic queries over raw tree navigation

Suggested high-value selections included:

- Calls resolving to a particular exported symbol.
- Implementations of an interface.
- References whose narrowed type satisfies a relationship.
- Imports resolving to a package export, regardless of local aliasing or syntax.
- Declarations contributing to a merged symbol.

Raw visitors and native compiler access would remain escape hatches. The open question is whether queries should be direct Effect programs, composable data, code-shaped patterns, streams, or a layered combination.

### Let replacements look like TypeScript

Agents and developers are better at writing TypeScript syntax than remembering large compiler-factory signatures. One candidate API used typed, parsed templates:

```ts
Syntax.expression`Effect.succeed(${value})`;
Syntax.statement`const ${name} = ${initializer}`;
```

The intended rule was not “trust strings.” Templates would be parsed immediately, checked for the required syntax category, and carry structural holes with hygienic binding and import handling. The native factory API would remain available when exact construction is preferable.

This is explicitly unresolved and requires a prototype against native hybrid AST printing.

### Make snapshot lifetimes honest

A raw node belongs to a particular immutable snapshot. The proposal rejected any API that pretends the same node object remains meaningful after project state changes.

An anchor might contain some combination of snapshot ID, configured project, file, native node index, syntax kind, source-range fingerprint, or symbol evidence. Applying an old plan should either explicitly re-resolve its references or fail as stale. The exact identity model is unknown until native behavior is tested.

### Do not make whole-file printing the default edit model

Whole-file AST printing may destroy comments, trivia, formatting, and intentionally untouched text. The initial proposal preferred:

- Compiler-provided refactors or text changes where available.
- Printing only newly synthesized fragments.
- Splicing minimal source ranges.
- Detecting overlapping edits.
- Parsing and checking the virtual result before producing or applying a diff.

The degree of fidelity that can be guaranteed is a prototype question.

## Initial reliability and agent hypotheses

An agent-facing transformation was expected to answer:

- Which files may this touch?
- How many matches were found?
- Why did each match qualify?
- Which semantic facts were used?
- What exact edits are proposed?
- Did diagnostics improve or regress?
- Is a second execution a no-op?
- Has the underlying workspace changed since planning?
- Which recipe operation produced each diff hunk?

Possible plan policies or assertions included:

- Maximum files and maximum matches.
- Allowed and excluded paths.
- Excluding dependencies or generated files.
- Expected symbol identity.
- No new diagnostics or an explicitly permitted diagnostic delta.
- Idempotence where the recipe promises it.
- Complexity, timeout, or resource budgets.

The open question is which of these are core reliability guarantees, optional verification policies, recipe-specific assertions, or future work.

## Initial proof-of-concept hypothesis

The proposed proof of concept deliberately avoided wrapping the entire compiler API. It suggested proving:

1. An Effect v4 scoped adapter around `typescript/unstable/async`.
2. Immutable snapshots and snapshot-bound references.
3. Batched semantic queries for declarations, references, symbols, and types.
4. A small edit algebra: replace, insert, and remove.
5. Native printing of categorized replacement fragments.
6. Plan preview, edit-overlap detection, and stale-snapshot detection.
7. Verification by constructing a virtual next snapshot and comparing diagnostics.
8. Representative transformations such as a semantic call rewrite, import rewrite, and symbol-oriented change.

The initial product pitch was:

> A typed, Effect-native transaction layer over TypeScript 7 snapshots: semantic queries in, verified changes out.

## Propositions requiring review

The review ticket should classify each proposition as accepted now, assigned to an existing decision/prototype ticket, reshaped, rejected, or out of scope.

1. The compiler should be treated as a remote semantic service rather than hidden behind a mutable wrapper graph.
2. The central lifecycle should be query → plan → verify → preview → explicit apply.
3. Snapshot-bound identity and honest staleness should replace long-lived mutable node wrappers.
4. Semantic selection should be first-class, with raw native visitors as an escape hatch.
5. Transformation Plans should be inspectable; whether they must be serializable is still open.
6. Parsed, typed TypeScript templates may be more agent-friendly than factory-heavy construction.
7. Minimal source edits should be preferred over whole-file printing.
8. Effect v4 should be the public orchestration model while immutable domain values remain plain data where practical.
9. Effect Request batching may provide the semantic query execution model over IPC.
10. Reliability policies, evidence, and application capability are more important differentiators than AST convenience methods.
11. The proof of concept should stay deliberately narrow while testing choices that could block future multi-project use.
