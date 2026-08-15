# Prove one end-to-end Transformation Recipe

Type: prototype
Status: resolved
Blocked by: 05, 06, 07, 08, 10

## Comments

- Claimed to prove a semantic, alias-aware and idempotent argument migration through plan, virtual diagnostics, preview, and explicit application.

## Question

Can the smallest combined API express one semantic Transformation Recipe elegantly and reliably from query through deterministic Plan, preview, verification, and explicit Application? Choose one representative rewrite and use it to challenge inference, lifecycle safety, native escape hatches, error clarity, source fidelity, and repeated execution before expanding coverage.

## Answer

Yes. The vertical slice migrates calls of a canonical exported `target(number)` API to `target({ value: number })` across an import alias and a re-export alias. It deliberately includes `other(2)` and `local.target(3)` counterexamples, a comment inside the rewritten call, and unusual surrounding spacing.

The recipe's core is ordinary typed Effect code:

```ts
const selections = yield* calls(project).pipe(
  whereBatched(resolvesToSymbol(project, target)),
  Stream.filter(hasUnwrappedSingleArgument),
  collect,
)
```

`selections` infers native `CallExpression` values. For each selection, the recipe replaces only the argument range, carries semantic evidence into a guarded Text Edit, fingerprints every project-owned compiler input plus configuration, declares exact cardinality/no-new-errors/idempotence policies, and finalizes a canonical durable Plan. Neither recipe nor preview writes.

Verification opens a fresh TypeScript 7 compiler authority against the virtual outputs. It proves the proposed project has no new errors and the same semantic recipe selects zero calls on its second run. Explicit Application then writes exactly two files. Assertions prove the import-alias and re-export calls changed, the comment and unusual spacing survived, and symbol-similar counterexamples remained byte-identical.

The slice also found and corrected a significant native-lifecycle hazard: TypeScript 7 can retain decoded source nodes across snapshots even though checker handles are generation-local. Passing a retained node to a newer `getSymbolAtLocation` produced a stale-handle error. The query implementation now batches stable file/position requests through `getSymbolAtPosition`; Verification uses an isolated compiler over the full overlay. This confirms why snapshot capability design and executable prototypes are essential rather than decorative.

The resulting API division is small and sufficient:

1. `Workspace.withSnapshot` supplies checked project authority.
2. typed Query streams produce native, evidence-bearing Selections;
3. recipe-local code compiles selections into a finalized Transformation Plan;
4. `previewPlan` computes exact output bytes;
5. isolated virtual Verification produces a Verified Plan and receipt;
6. `PlanApplication.apply` is the sole explicit write boundary.

The proof is deliberately not the final public naming or convenience surface. It validates the semantics needed to shape that API next; import helpers, rename/reference closure, parsed templates, richer diagnostics, and production recovery remain later work.

Prototype: [`src/prototype/wrap-target-recipe.ts`](../../../src/prototype/wrap-target-recipe.ts), [`src/prototype/end-to-end.test.ts`](../../../src/prototype/end-to-end.test.ts), and [`fixtures/recipe`](../../../fixtures/recipe).
