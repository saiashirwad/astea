# Choose the semantic query and selection model

Type: prototype
Status: resolved
Blocked by: 03, 04

## Comments

- Claimed to compare direct Effect queries, query descriptions, code-shaped matching, streaming, and raw native traversal against real alias- and symbol-sensitive selections.
- Implemented `src/prototype/semantic-query.ts` and a fixture that distinguishes canonical-symbol matches from syntactically similar calls across direct aliases, re-exports, unrelated imports, and same-text local properties.

## Question

How should a Transformation Recipe describe and execute syntactic and semantic selections? Compare direct native visitors, composable query values, code-shaped patterns, streams, and checker-backed predicates; determine where batching, caching, cardinality assertions, explanations, and the raw compiler escape hatch belong.

## Answer

A Semantic Query should be executable Effect code represented as a composable Effect Stream of evidence-bearing Selection values. It should not be a serializable query AST.

The prototype model is:

```ts
type Query<A, E, R> = Stream.Stream<Selection<A>, E, R>

interface Selection<A> {
  readonly value: A
  readonly fileName: string
  readonly start: number
  readonly end: number
  readonly evidence: ReadonlyArray<QueryEvidence>
}
```

Here `A` is the native TypeScript node or semantic value, not a parallel wrapper hierarchy. Native type guards preserve precise inference: seeding with `isCallExpression` produces `Query<CallExpression, ...>`, and downstream criteria receive `CallExpression` without casts or duplicated discriminants.

### Authoring model

A recipe is an ordinary Effect program inside a Workspace Snapshot region. It obtains an explicit Project Snapshot, constructs or composes Query streams, and eventually collects or consumes Selections:

```ts
const selections = yield* calls(project).pipe(
  whereBatched(resolvesToSymbol(project, target)),
  collect,
)
```

This separates four orthogonal concerns:

1. A syntax seed traverses native source trees and produces typed candidates.
2. A semantic criterion evaluates candidates against the native checker, preferably in batches.
3. Each admitted candidate gains structured Query Evidence.
4. A terminal operation consumes the stream or collects it in canonical source order.

The prototype query selected calls to an exported `target` function through both an import alias (`renamed(1)`) and a re-export alias (`publicTarget(4)`). It excluded another imported function and `local.target(3)`, despite the latter's matching text. Every result contains syntax-kind evidence plus the canonical symbol name and project-relative declaration path.

### Alternatives considered

#### Direct native visitors only

Keep as an escape hatch, not the primary API. Native traversal is capable and local over the binary AST, but direct visitors mix file enumeration, traversal, IPC scheduling, evidence, ordering, and failure handling in every recipe.

#### Serializable query-description AST

Rejected as the core. A closed query algebra would duplicate an expanding portion of TypeScript's checker API, constrain arbitrary user logic, complicate type inference, and still require an escape hatch for serious codemods. Transformation Plans need inspectability; recipe queries do not need serialization.

#### Eager arrays

Useful only at a terminal boundary. Arrays are simple but force full materialization and make large-project traversal, controlled concurrency, and composition less natural. `collect` deliberately converts a Query stream to a canonically sorted array when planning needs exact counts and deterministic evidence.

#### Effect Streams

Selected as the query value. Streams are Effect-native, preserve requirements and typed failures, compose without a new runtime, support incremental project traversal and concurrency, and can group candidates before semantic IPC.

#### Code-shaped patterns

Deferred as optional syntax sugar over query seeds and criteria. They earn a place only if later prototypes materially improve recipe readability and inference. They should not become a separate semantic authority or a custom AST hierarchy.

### Batching and caching

Semantic criteria must be batch-aware. The prototype `whereBatched` groups candidates and requires an aligned optional evidence result for each input. Its `resolves-to-symbol` criterion uses the native checker's array overload, making one symbol request for a candidate batch rather than one request per call.

The batch size of 128 is experimental, not a decision. Native array overloads should be used directly wherever they exist. Effect `Request` / `RequestResolver` remains a later hypothesis: it should be adopted only if it improves deduplication and automatic batching without obscuring query inference or deterministic ordering.

Rely on native snapshot caches for source buffers, symbols, and types initially. Add userland query caching only for repeated measured work with an identity model capable of safe snapshot-local keys.

### Evidence and cardinality

Every Selection carries structured Query Evidence from the criteria that admitted it. A boolean-only semantic predicate is insufficient for reliable transformations because it cannot explain why a candidate qualified. The eventual Transformation Plan copies relevant selection evidence into Plan Evidence.

Expected match counts, maximum files, and other cardinality checks remain Plan Policies. Query execution reports actual selections; it does not silently impose or satisfy application policy. Canonical collection orders by normalized project/file identity and source range rather than discovery timing.

### Raw native escape hatch

Project Snapshot exposes an explicitly named `unsafeNative` callback in the prototype. It checks region validity before yielding the native project, and all normal query primitives are built above the same bounded authority. Returning native compiler objects from this callback can bypass expiry protection, so use of the raw escape hatch is outside normal facade guarantees and must remain visibly unsafe.

The product API should expose native TypeScript nodes from Selections, but checker, program, emitter, and project authority should normally remain behind snapshot-scoped operations.

### Reference and alias findings

- `getSymbolAtLocation` has a useful array overload and preserves aligned output.
- `getAliasedSymbol` follows an alias to its canonical target but has no array overload in the exercised API.
- `getReferencesToSymbolInFile` requires one file at a time and is not transitive through downstream aliases. Against the canonical target it found its declaration/import/export sites but did not directly return use sites of the re-exported alias.
- Project-wide reference discovery therefore needs alias-closure logic, deliberate per-file scheduling, or a stronger native API. Treating the current per-file call as complete project references would be incorrect.
- Native canonical paths are case-normalized on the current filesystem. Evidence must normalize them to project/workspace-relative identities before becoming deterministic Plan Evidence.
- Decoded source nodes may be retained across Workspace Snapshots while checker handles are generation-local. The vertical slice reproduced stale native handles when an unchanged decoded node was sent to a newer checker's `getSymbolAtLocation`. Semantic criteria therefore send file/position arrays to `getSymbolAtPosition` when an equivalent positional operation exists; live native nodes remain author-facing values, not cross-generation request handles.

### Decision

Use Effect Streams as thin executable Query values. Seed them with native TypeScript traversal and guards, enrich them through evidence-producing batched semantic criteria, and collect them deterministically at planning boundaries. Keep cardinality in Plan Policies, rely on native caches first, defer code-shaped patterns and Effect Request batching until they prove material value, and retain an explicit unsafe region-bound native escape hatch.
