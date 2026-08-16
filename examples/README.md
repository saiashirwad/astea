# Safemods Examples & Declarative Architecture Tour

This directory provides concrete examples and guides explaining how `safemods` delivers declarative, composable, and effectful TypeScript project transformations compared to legacy AST manipulation tools (such as `ts-morph` or `jscodeshift`).

---

## 1. In-Memory Snapshot Transitions (`snapshot.overlay`)

### What it solves
Multi-phase transformations (e.g. migrating an exported function signature in a library and subsequently refactoring downstream call sites across consuming files) previously required either writing intermediate states to disk or discarding type-checker caches.

### How `safemods` does it
`safemods` uses TypeScript 7's in-memory file overrides to project proposed edits into a new generation `WorkspaceSnapshot` without touching the filesystem:

$$\text{Snapshot}_0 \xrightarrow{\text{Recipe}_1} \text{Draft}_1 \xrightarrow{\text{overlay}} \text{Snapshot}_1 \xrightarrow{\text{Recipe}_2} \text{Draft}_2 \implies \text{Final Plan}$$

```ts
import { Effect } from "effect"
import * as Draft from "safemods/Draft"
import * as Overlay from "safemods/Overlay"
import { WorkspaceSnapshot } from "safemods/Workspace"

const twoPhaseMigration = Effect.gen(function*() {
  const snapshot = yield* WorkspaceSnapshot
  const project = yield* snapshot.project(app)

  // Stage 1: In-memory draft for library.ts
  const draft1 = yield* Draft.imports.addNamed(project, "src/library.ts", {
    module: "./types.js",
    name: "NewConfig",
  })

  // Stage 2: Query the updated semantic state inside the overlay
  return yield* Overlay.run(draft1, Effect.gen(function*() {
    const overlaySnapshot = yield* WorkspaceSnapshot
    const overlayProject = yield* overlaySnapshot.project(app)
    // Downstream files now see `NewConfig` resolved by the compiler!
    return yield* Draft.concat(draft1, /* stage 2 draft */)
  }))
})
```

---

## 2. Declarative Pattern Matchers & Query Algebra (`Pattern` & `Criterion`)

### What it solves
Legacy codemods relied on deeply nested `if` statements, manual AST node type casting, and repetitive compiler queries.

### How `safemods` does it
1. **Structural Patterns (`Pattern`)**: Matches syntax trees and binds typed values in one step:
   ```ts
   const targetPattern = Pattern.callExpression({
     expression: Pattern.identifier({ resolvesTo: canonicalSymbol }),
     arguments: Pattern.tuple([
       Pattern.bind("firstArg", Pattern.not(Pattern.objectLiteral())),
     ]),
   })

   const matches = yield* Query.match(project, targetPattern).pipe(Query.collect)
   ```
2. **Algebraic Criteria (`Criterion`)**: Boolean algebra over semantic criteria:
   ```ts
   Query.where(
     Criterion.all(
       Query.resolvesTo(targetSymbol),
       Criterion.not(Query.hasJSDocTag("deprecated")),
       Query.textMatches(/includePattern/),
     )
   )
   ```

---

## 3. High-Fidelity Syntactic Draft Combinators (`Draft.imports`, `Draft.args`, `Draft.objectLiteral`)

### What it solves
Full AST re-printing often strips comments, custom line breaks, and project formatting styles.

### How `safemods` does it
All syntactic operations operate on **minimal range slices guarded by cryptographic old-text hashes**:

```ts
// 1. Manage named imports while preserving quote styles and multiline formatting
yield* Draft.imports.addNamed(project, "src/index.ts", { module: "effect", name: "Option" })
yield* Draft.imports.removeNamed(project, "src/index.ts", { module: "./legacy.js", name: "oldFn" })

// 2. Wrap or reorder function call arguments without altering trivia
yield* Draft.args.wrap(project, callNode, 0, (text) => `{ value: ${text} }`)
yield* Draft.args.reorder(project, callNode, [1, 0])

// 3. Insert or modify object literal fields with inferred indentation
yield* Draft.objectLiteral.setField(project, objectNode, "timeoutMs", "5000")
```

---

## 4. Higher-Order Recipe Combinators (`Recipe.pipe`, `Recipe.all`, `Recipe.branch`) & Schema Validation

Recipes are first-class, composable algebraic values:

* **`Recipe.pipe(...recipes)`**: Runs recipes in sequence, passing intermediate states via virtual in-memory overlays and merging drafts into a unified plan.
* **`Recipe.all(recipes)`**: Evaluates independent recipes concurrently and merges drafts, failing deterministically if edit ranges conflict.
* **`Recipe.branch(predicate, ifTrue, ifFalse)`**: Branches transformation logic based on compiler settings or file structure.
* **`schema: Schema.Schema<Input>`**: Enforces input validation using `@effect/schema` before recipe execution.

```ts
export const fullMigration = Recipe.pipe(
  migrateLibrarySignature,
  updateConsumerCallSites,
)
```

---

## 5. Diagnostic Diffs & Declarative Verification Policies

### What it solves
A naive "no compiler errors allowed" rule prevents refactoring in legacy projects with pre-existing errors.

### How `safemods` does it
`Verification` computes a complete **Diagnostic Diff** ($\text{Diagnostics}_{\text{proposed}} - \text{Diagnostics}_{\text{baseline}}$) and evaluates declarative policies:

```ts
export const safeRecipe = Recipe.define("safe-migration", {
  version: "1.0.0",
  policies: [
    // Ensure no NEW errors are introduced (pre-existing baseline errors tolerated)
    Policy.noNewErrors(),

    // Assert that a specific error code was resolved by this transformation
    Policy.fixesError("TS2345"),

    // Replay idempotence check: f(f(x)) === f(x)
    Policy.idempotent(),

    // Match count expectations
    Policy.matches({ min: 1 }),
  ],
  run: (input) => Effect.gen(function*() { ... }),
})
```

---

## Running the Tour Example

To execute the complete interactive tour:

```sh
pnpm check
node examples/declarative-api-tour.ts
```
