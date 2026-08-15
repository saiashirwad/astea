# Candidate public API design

Status: candidate public surface for the implementation-ready specification's stage 6

Audience: the project owner; production implementers

Executable evidence: `src/api/` (surface + two example recipes), `src/api/api.test.ts` (typed end-to-end pipeline, determinism, and trivia-preservation proofs against the real native compiler).

This document records the naming and authoring-shape decisions the implementation-ready specification deliberately left open. It changes no behavior contract: everything proven in the prototypes still holds, and the facade preserves the specification's invariants. Where a name here conflicts with the specification's provisional facade, this document wins; where behavior conflicts, the specification wins.

## The pipeline is the API

```text
Workspace.layer({ projects: [...] }, { cwd })
  └─ Recipe.run(recipe, input)        → TransformationPlan   (query + draft + engine finalization)
       └─ Preview.of(plan)            → PlanPreview          (exact proposed bytes, no writes)
            └─ Verification.verify(plan, recipe, input)
                                   → VerifiedPlan            (fresh baseline + proposed authorities)
                 └─ Application.apply(verified)
                                   → ApplicationReceipt      (the only write in the system)
```

An agent can read the types left to right and discover the whole system. Each stage is explicit; no stage before Application writes; Application accepts only the branded Verified Plan (enforced at the type level — `api.test.ts` carries a `@ts-expect-error` proving a raw plan is rejected).

## What the author no longer writes

The prototype recipes (`wrap-target-recipe.ts`, `stress-recipes.ts`) were roughly 60% plumbing. The candidate surface absorbs all of it:

| Prototype plumbing | Candidate surface |
| --- | --- |
| `Fs.readFile` + `indexOf` to locate a declaration symbol | `project.symbolNamed("target", { within: file })` — native, overlay-aware |
| Hand-sliced ranges, `textHash` guards | derived by `Draft` builders from the native node |
| Hand-built `evidenceId` strings | derived: `selection:{projectId}:{file}:{start}` |
| `selection.evidence` copied into records by hand | inherited automatically by `Draft.replaceEach` |
| Source-fingerprint loops per recipe | engine fingerprints the observed workspace in `Recipe.run` |
| Toolchain literals in every recipe | engine-owned `TOOLCHAIN` (real version capture is a production task) |
| Manual `VerificationObservation` assembly and overlay wiring | `Verification.verify(plan, recipe, input)` owns both isolated authorities |
| `Policy` object literals with all four fields | `Policy.matches / noNewErrors / idempotent / atMostFiles` composable values with defaults |

The wrap-target recipe drops from ~135 lines of mixed intent and plumbing to ~35 lines of intent (`src/api/wrap-target-input.ts`); the import migration (`src/api/migrate-import-source.ts`) shows the surface is not overfit to one recipe.

## Service-or-value dispositions

Per the Effect service-design test (does the module own persistence, lifecycle, or real production/test variation?):

**Services (authority seams):**

- `Workspace` — owns workspace configuration, the native compiler lifecycle, transition serialization, and isolated verification sessions (`withIsolatedSnapshot`: a fresh compiler authority over a virtual filesystem; the overlay always wins, nothing writes). Delete it and every caller re-implements process and region management.
- `WorkspaceSnapshot` — region-provided capability; expiry enforcement is its reason to exist.
- `PlanApplication` — deliberately separate write authority so planning/verification runtimes can omit it. Production adapter `planApplicationLayerNode` reads the workspace root from the ambient `Workspace`.
- `NativeCompiler` — internal technology service (unchanged from the prototype); raw process/client/protocol values never cross the public boundary.

**Values or Effect-returning functions (deletion test failed; no authority owned):**

- `ConfiguredProject` — plain frozen value with a durable caller-chosen `id` and workspace-relative `config`. Absolute paths are runtime lookup details and never enter durable artifacts.
- `Query`, `Selection`, `Criterion`, `QueryEvidence` — a Query is a Stream of Selections; criteria are values. No query service.
- `Draft`, `ProposedEdit` — immutable assembled value, not a stateful builder service. `Draft` operations are functions because they derive data from region-bound nodes; they own no lifecycle.
- `Recipe` — a plain definition value; `Recipe.run` is the engine function that owns finalization.
- `Plan`, `Policy`, receipts, evidence — serializable values and codecs.
- `Preview` / `Verification` — functions requiring `Workspace`, not services: they own no state or lifecycle beyond what Workspace already owns. The specification's prohibition on extra public services stands.

## Key shape decisions

1. **Selections carry their Project Snapshot.** Criteria such as `Query.resolvesTo(symbol)` take no project argument; each selection answers through its own snapshot, so one stream may mix projects. Rejected: passing `project` to every criterion (redundant, and the prototype showed authors repeating it twice per query); an ambient `ProjectSnapshot` context (hides the multi-project reality the domain model insists on).
2. **Recipes return Drafts; the engine finalizes.** `Recipe.run` opens the region, evaluates the body, fingerprints the observed workspace, attaches recipe identity/policies/measurements, and finalizes. Recipes cannot forge snapshot evidence and idempotence replay gets an unfinalized draft — the specification's §5 contract.
3. **`Plan` exposes only `serialize`/`parse`.** `finalize` is internal to the engine; the prototype facade's public `Plan.finalize` is gone.
4. **`Verification.verify` replays the recipe itself.** It takes the recipe and input, spins up baseline and proposed isolated authorities, computes the diagnostic delta, evaluates policies, and — when the plan declares idempotence — requires the replayed draft to be empty. The primary-run match count travels in the plan as a planning-time measurement (`plan.measurements.matches`), so verification needs no out-of-band observations.
5. **Native types stay visible with exact inference.** `Query.calls(project)` is a `Stream<Selection<CallExpression>>`; guards infer exactly; `unsafeNative` remains the explicitly unstable escape hatch. No parallel node hierarchy.
6. **Edit intent is expressed against nodes, not ranges.** `Draft.replace / replaceWith / remove / insertBefore / insertAfter / replaceEach`. Leading trivia is preserved by default; widening (`includeLeadingTrivia`) is explicit. Native printing produces fragments only (`Draft.print`), never whole files.
7. **One surface for humans and agents.** Same functions, same types; nothing in the surface distinguishes an agent caller from a human one.

## Type-level guarantees (asserted in `api.test.ts`)

- `Recipe.define` preserves input/error/requirement inference.
- `Query.calls` infers `CallExpression` exactly.
- `Application.apply` rejects a raw `TransformationPlan` (`@ts-expect-error`) and accepts `VerifiedPlan`.

## Honest gaps (unchanged from the specification's known-gaps list)

- `Recipe.run` fingerprints project-owned sources and configuration, not the complete resolution manifest; the manifest recorder is stage 2.
- Plan decode validation remains shallow; production needs a complete runtime schema.
- Verification compares diagnostic counts; production needs normalized diagnostic identities.
- `TOOLCHAIN` is a pinned constant; production captures real versions.
- Parsed templates, refactor-backed conveniences, rename/import conveniences above the kernel: deferred, and must compile to Text Edits when added.

## Evidence index

| Surface | Files |
| --- | --- |
| Workspace/snapshot regions, `symbolNamed`, isolated sessions | `src/api/workspace.ts` |
| Query/Selection/Criterion, `resolvesTo` | `src/api/query.ts` |
| Draft builders | `src/api/draft.ts` |
| Policies | `src/api/policy.ts` |
| Durable plan codec | `src/api/plan.ts` |
| Recipe engine | `src/api/recipe.ts` |
| Preview/Verification | `src/api/verification.ts` |
| Application seam | `src/api/application.ts` |
| Example recipes | `src/api/wrap-target-input.ts`, `src/api/migrate-import-source.ts` |
| Typed end-to-end proof | `src/api/api.test.ts` |
