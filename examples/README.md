# Safemods Examples & Declarative Architecture Tour

This directory provides concrete examples and guides explaining how `safemods` delivers declarative, composable, and effectful TypeScript project transformations compared to legacy AST manipulation tools (such as `ts-morph` or `jscodeshift`).

---

## 1. In-Memory Snapshot Transitions (`Overlay.composeDraft`)

### What it solves

Multi-phase transformations (e.g. migrating an exported function signature in a library and subsequently refactoring downstream call sites across consuming files) previously required either writing intermediate states to disk or discarding type-checker caches.

### How `safemods` does it

`safemods` uses TypeScript 7's in-memory file overrides to project proposed edits into a new generation `WorkspaceSnapshot` without touching the filesystem. `Overlay.composeDraft` rebases the later Draft onto the original snapshot so the result is one Draft, not two concatenated against different source states:

Snapshot 0 --Draft 1--> Overlay --Draft 2--> rebase onto Snapshot 0 => one Draft

```ts
import { Effect } from "effect"
import * as Draft from "safemods/Draft"
import * as Overlay from "safemods/Overlay"
import { WorkspaceSnapshot } from "safemods/Workspace"

const twoPhaseMigration = Effect.gen(function* () {
  const snapshot = yield* WorkspaceSnapshot
  const project = yield* snapshot.project(app)

  const draft1 = yield* Draft.imports.addNamed(project, "src/library.ts", {
    module: "./types.js",
    name: "NewConfig",
  })

  return yield* Overlay.composeDraft(
    draft1,
    Effect.gen(function* () {
      const overlaySnapshot = yield* WorkspaceSnapshot
      const overlayProject = yield* overlaySnapshot.project(app)
      return yield* Draft.imports.addNamed(overlayProject, "src/consumer.ts", {
        module: "./library.js",
        name: "NewConfig",
      })
    }),
  )
})
```

Use `Overlay.run` when the program only inspects the overlay or returns something other than a Draft.

---

## 2. Declarative Pattern Matchers & Query Algebra (`Pattern` & `Criterion`)

### What it solves

Legacy codemods relied on deeply nested `if` statements, manual AST node type casting, and repetitive compiler queries.

### How `safemods` does it

1. **Structural Patterns (`Pattern`)**: Matches syntax trees and binds typed values in one step:
   ```ts
   const targetPattern = Pattern.callExpression({
     expression: Pattern.identifier({ resolvesTo: canonicalSymbol }),
     arguments: Pattern.tuple([Pattern.bind("firstArg", Pattern.not(Pattern.objectLiteral()))]),
   })

   const matches = yield * Query.match(project, targetPattern).pipe(Query.collect)
   ```
2. **Algebraic Criteria (`Criterion`)**: Boolean algebra over semantic criteria:
   ```ts
   Query.where(
     Criterion.all(
       Query.resolvesTo(targetSymbol),
       Criterion.not(Query.hasJSDocTag("deprecated")),
       Query.textMatches(/includePattern/),
     ),
   )
   ```

---

## 3. High-Fidelity Draft Mutations (`Draft.replaceEach`, `Draft.replaceWith`, `Draft.imports`)

### What it solves

Full AST re-printing often strips comments, custom line breaks, and project formatting styles.

### How `safemods` does it

All syntactic operations operate on **minimal range slices guarded by cryptographic old-text hashes**:

```ts
yield * Draft.imports.addNamed(project, "src/index.ts", { module: "effect", name: "Option" })

const [legacyImport] =
  yield * Query.imports(project).pipe(Query.where(Query.textMatches("./legacy.js")), Query.collect)
if (legacyImport !== undefined) {
  yield * Draft.imports.removeNamed(project, legacyImport.value, "oldFn")
}

yield * Draft.replace(project, targetArgument, `{ value: ${targetArgument.getText()} }`)

yield *
  Draft.replaceEach(calls, ({ value: call }) => {
    const argument = call.arguments[0]!
    return { node: argument, text: `{ value: ${argument.getText()} }` }
  })
```

---

## 4. Higher-Order Recipe Combinators (`Recipe.pipe`, `Recipe.all`, `Recipe.branch`) & Schema Validation

Recipes are first-class, composable algebraic values:

- **`Recipe.pipe(...recipes)`**: Runs recipes in sequence. Later stages query an Overlay of earlier Drafts; Overlay rebases each later Draft onto the original snapshot.
- **`Recipe.all(recipes)`**: Evaluates independent recipes concurrently and merges drafts, failing deterministically if edit ranges conflict.
- **`Recipe.branch(predicate, ifTrue, ifFalse)`**: Branches transformation logic based on compiler settings or file structure.
- **`schema: Schema.Schema<Input>`**: Enforces input validation using `Schema` from `effect` before recipe execution.

```ts
export const fullMigration = Recipe.pipe(migrateLibrarySignature, updateConsumerCallSites)
```

---

## 5. Diagnostic Diffs & Declarative Verification Policies

### What it solves

A naive "no compiler errors allowed" rule prevents refactoring in legacy projects with pre-existing errors.

### How `safemods` does it

`Verification` computes a complete diagnostic diff (proposed minus baseline) and evaluates declarative policies:

```ts
export const safeRecipe = Recipe.define("safe-migration", {
  version: "1.0.0",
  policies: [
    Policy.noNewErrors(),
    Policy.fixesError(2345),
    Policy.idempotent(),
    Policy.matches({ min: 1 }),
  ],
  run: (input) => Effect.gen(function*() { ... }),
})
```

---

## Checking the Tour Example

The tour is source documentation rather than a supported standalone Node
command. Type-check it with the rest of the examples:

```sh
pnpm typecheck
```

## Recipe Modules

These TypeScript examples define recipe modules suitable for loading from the
CLI or an agent host:

- `semantic-api-migration.ts` combines schema input, semantic symbol resolution, dual query operators, argument rewriting, and idempotence verification.
- `overlay-aware-migration.ts` stages an import in a virtual snapshot before querying the updated project state.
- `agent-tool.ts` exposes a schema-validated recipe through the structured Agent Tool protocol.
