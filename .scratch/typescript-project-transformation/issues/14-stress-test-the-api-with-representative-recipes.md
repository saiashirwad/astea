# Stress-test the API with representative Transformation Recipes

Type: prototype
Status: resolved
Blocked by: 11

## Comments

- Claimed as the prerequisite to issue 12. The stress matrix will add import- and symbol-oriented recipes and exercise ambiguity, diagnostics, trivia, idempotence, and staleness without adding convenience abstractions prematurely.

## Question

After one vertical slice is accepted as elegant, does the API remain reliable across meaningfully different transformations? Exercise a semantic call rewrite, an import migration, and a symbol-oriented change, including ambiguous matches, pre-existing diagnostics, comments, repeated execution, and a changed workspace between planning and Application. Identify abstractions that generalize and conveniences that should remain outside the core.

## Answer

The core model held across three meaningfully different recipes without adding another public service or edit representation:

1. The existing semantic call rewrite migrated a canonical function through import and re-export aliases.
2. An import migration changed only a module-specifier string while preserving quote style, import comments, aliases, and unrelated spacing.
3. A canonical-symbol rename changed the declaration, direct import/use sites, aliased import property, and re-export property while preserving the local alias, re-exported public name, same-text unrelated local, and comments.

All three use native typed nodes, evidence-bearing Query streams, semantic criteria backed by file/position checker batches, guarded Text Edits, one durable plan format, isolated virtual Verification, and the same explicit Application capability. The symbol exercise generalized `resolvesToSymbol` into `resolvesNodeToSymbol<A extends Node>` without weakening inference or introducing wrappers.

The stress matrix proved:

- exact selection/cardinality policies work for syntax-, import-, and symbol-oriented recipes;
- the default diagnostic policy correctly tolerates an unchanged pre-existing error while rejecting a regression;
- minimal ranges preserve comments, aliases, quote style, and unrelated formatting;
- rerunning every recipe against virtual output yields zero candidates;
- a destination-name collision fails planning with typed `RenameConflict`, not a partial Plan;
- changing an unrelated semantic input after Verification makes the Plan stale before Application;
- successful multi-file symbol Application changes four files and leaves counterexamples untouched.

The stale-workspace case found and fixed a contract gap: Application must immediately rehash the complete declared semantic input set, not only affected files. Otherwise an unrelated dependency could change after Verification while edited files remained byte-identical. The Application prototype now performs that full check before staging.

The abstractions that generalized are Workspace/Snapshot authority, typed Query/Selection/Evidence, a generic batched semantic criterion, durable Plan/Policy/Evidence, guarded Text Edit, Preview, Verification, and explicit Application. Import migration and symbol rename remain recipe-library conveniences built from the core. Their ambiguity rules, alias policies, destination-conflict analysis, and user ergonomics are too operation-specific to place in the minimal kernel.

Prototype: [`src/prototype/stress-recipes.ts`](../../../src/prototype/stress-recipes.ts), [`src/prototype/stress-recipes.test.ts`](../../../src/prototype/stress-recipes.test.ts), and [`fixtures/stress`](../../../fixtures/stress).
