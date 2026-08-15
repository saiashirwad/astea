# Shape the implementation-ready specification

Type: prototype
Status: resolved
Blocked by: 04, 05, 06, 07, 08, 09, 10, 11, 14

## Comments

- Claimed after resolving the representative-recipe blocker. The artifact will specify the proven semantic contract and a provisional TypeScript facade, with executable conformance probes rather than treating naming aesthetics as settled.

## Question

Using the proven API and closed decisions, what exact public contract, internal architecture, invariants, error model, module boundaries, test strategy, compatibility policy, and staged implementation plan should be handed to a production implementation effort? Produce a concrete specification artifact and refine it with the human until it is accepted as implementation-ready.

## Answer

The production handoff is the [implementation-ready candidate specification](../briefing/implementation-ready-specification.md). It defines the normative semantic contract, compatibility baseline, lifecycle and authority boundaries, Query/Selection model, complete snapshot input manifest, identity/evidence, guarded edits, canonical Plan schema, policies, isolated Verification, Application/recovery outcomes, tagged error families, module architecture, concurrency/caching rules, release test matrix, and a six-stage implementation plan.

The specification deliberately separates two levels:

- The reliability and lifecycle contract is implementation-ready and must not be weakened by later authoring-API work.
- Names, namespaces, fluent composition, and Draft Plan ergonomics are provisional because the project owner intends to design that surface next.

An executable facade probe proves that one plausible surface preserves recipe input/error/requirement inference, exposes native `CallExpression` from `Query.calls`, and runs the same typed recipe for agents and humans. It does not freeze those names.

The final prototype pass added material requirements that were not obvious from the original synthesis:

1. Application revalidates the complete semantic input set immediately before staging, including unrelated inputs.
2. The durable snapshot manifest must include negative resolution probes and directory/realpath observations, because a newly created file can change semantics without modifying an old file.
3. The engine, not recipe code, must own finalization and captured snapshot evidence. Idempotence replay inspects an empty Draft Plan without reapplying primary-run match minima.
4. Native canonical paths and durable project-relative paths are different identities; filesystem case behavior must be explicit and locale-independent.
5. Verification begins with isolated compiler authority over the complete virtual filesystem until cache reuse has an equivalence proof.

The TypeScript filesystem callback probe confirms that file reads and existence probes are observable at the native adapter boundary, making a complete recorder feasible. The representative recipe matrix and contract probes pass. Known gaps—complete runtime schema decoding, full resolution-manifest capture, normalized diagnostic identities, engine-owned finalization, project references, exhaustive rollback fault injection, and final API aesthetics—are explicit staged work rather than implied guarantees.

Primary evidence: [`src/prototype/public-api-probe.ts`](../../../src/prototype/public-api-probe.ts), [`src/prototype/public-api-probe.test.ts`](../../../src/prototype/public-api-probe.test.ts), and [`src/prototype/snapshot-manifest.test.ts`](../../../src/prototype/snapshot-manifest.test.ts).
