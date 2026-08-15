# Review the initial design synthesis

Type: grilling
Status: resolved

## Question

Which propositions in the [initial design synthesis](../briefing/initial-design-synthesis.md) should become standing constraints, which should remain hypotheses for an existing prototype or decision ticket, which should be reshaped, and which should be rejected or ruled out of scope? Preserve the useful reasoning from the original exploration without allowing an untested first synthesis to become architecture by default.

## Comments

- Claimed for a live review with the project owner after they identified that the original synthesis had not been preserved by the map or glossary.
- Round 1: accepted the compiler-native transaction-system thesis, separation of planning from explicit application, reliability as a primary differentiator, and a deliberately narrow proof of concept with scale-safe boundaries. Elevated API elegance to a co-equal product goal. Left the proposed Effect orchestration / plain immutable data boundary open for clarification.
- Round 2: accepted that Effects represent operations while immutable values represent facts; recipe code uses native TypeScript nodes rather than a parallel hierarchy; Plans are initially in-process, immutable, deterministic, inspectable, and snapshot-bound; unrelated source regions remain byte-for-byte unchanged; and API elegance includes exceptional inference, orthogonal concepts, one human/agent API, Effect-managed execution, obvious native escape hatches, and lifecycle safety. Semantic querying as a first-class requirement was not answered and remains open.
- Round 3: accepted semantic querying as a core capability without committing to a separate DSL; retained parsed TypeScript templates only as a prototype candidate; rejected presuming `Request` / `RequestResolver` before comparison with direct async and batched compiler calls; routed reliability assertions to the reliability contract; and split proof into a native plumbing spike followed by one elegant end-to-end recipe before broader coverage.

## Answer

The initial synthesis is preserved as design input rather than discarded or adopted wholesale.

Accepted as standing constraints:

- This is a compiler-native transformation transaction system, not a replacement mutable AST wrapper hierarchy.
- Recipe code operates on native TypeScript nodes within an honest Project Snapshot lifetime.
- Querying and planning do not write; Application is always explicit.
- Effects represent operations, lifecycle, capabilities, and failures while immutable values represent facts where practical.
- Reliability and API elegance are co-equal product goals. Excellent inference is a required part of elegance.
- Transformation Plans are initially immutable, deterministic, inspectable, in-process, and bound to their originating Project Snapshot.
- Semantic Querying is a core capability, with raw native access retained as an escape hatch.
- Source regions unrelated to an edit remain byte-for-byte unchanged.
- The proof of concept begins with one configured project while avoiding boundaries that inherently prevent multiple projects later.

Retained as hypotheses for focused prototypes:

- The exact Semantic Query authoring model.
- Snapshot-bound node and symbol reference mechanics.
- Parsed, typed TypeScript templates versus native factories for replacement construction.
- Minimal edit representation and comment/trivia behavior within edited ranges.
- `Request` / `RequestResolver` versus direct async and compiler-batched calls.
- Plan serialization, persistence, provenance, and resumption.
- The exact set of mandatory and configurable reliability assertions.

Explicitly not presumed:

- A parallel library-owned hierarchy for every TypeScript node kind.
- Whole-file AST printing as the ordinary edit mechanism.
- Plan serialization as a proof-of-concept requirement.
- Effect Request batching without measured API or IPC benefit.
- Parsed syntax templates as the chosen construction API before prototyping.

The proof proceeds in stages: first establish native compiler lifecycle facts, then prove one end-to-end semantic Transformation Recipe with the smallest plausible API, and only afterward stress-test the design with broader representative recipes.
