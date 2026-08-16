# safemods

> **Type-directed, transactional codemod and verification engine for TypeScript 7+ projects, built on Effect.**

`safemods` enables safe, automated, large-scale TypeScript refactorings and cross-package API migrations. It uses the TypeScript 7 Compiler API to track symbols across renamed imports, re-exports, and barrel files, drafts range-bounded edits that preserve trivia and formatting, verifies them against compiler diagnostics and idempotency policies in virtual memory, and applies them atomically with automatic rollback.

```
Query ──▶ Draft ──▶ Plan ──▶ Preview ──▶ Verify (In-Memory Compiler) ──▶ Apply (Atomic / Rollback)
```

---

## Why safemods?

Existing JavaScript/TypeScript codemod tools force developers to choose between **semantic precision** and **destructive side effects**:

* **Syntax-only tools (`jscodeshift`, `ast-grep`, `GritQL`)** are fast, but blind to types. They cannot differentiate between `UserService.get(...)`, `Map.prototype.get(...)`, and `redis.get(...)`. Running a method rename with regex or AST patterns inevitably corrupts unrelated code.
* **Imperative AST wrappers (`ts-morph`)** are type-aware, but mutate internal compiler representations eagerly in place. Mutations invalidate parent/child node references (causing *"forgotten node"* errors), destroy formatting trivia on reprint, and provide no rollback mechanism when a multi-file migration fails midway.

**`safemods` is the OpenRewrite / LibCST of the TypeScript ecosystem.** It treats transformations as **pure, content-addressed data pipelines**:

| Feature | `jscodeshift` / `recast` | `ast-grep` / `GritQL` | `ts-morph` | `safemods` |
| :--- | :--- | :--- | :--- | :--- |
| **Engine / Parser** | Babel / Recast AST | Tree-sitter | TypeScript AST | **TypeScript 7 Compiler API** |
| **Type-Aware Queries** | ❌ None | ❌ None | ✅ `TypeChecker` | ✅ **Exact Symbol Resolution Streams** |
| **Cross-File Import Tracking** | ❌ Blind | ❌ Blind | ⚠️ Manual lookup | ✅ **Automatic (Barrels, Aliases, Re-exports)** |
| **Edit Model** | Full-file AST reprint | Tree-sitter patches | Mutable AST nodes | ✅ **Hash-guarded range text edits** |
| **Multi-Phase Staging** | ❌ File writes required | ❌ None | ❌ Reload project | ✅ **Virtual In-Memory Overlays** |
| **Compiler Verification** | ❌ None | ❌ None | ❌ Manual | ✅ **`Policy.noNewErrors()` & `Policy.idempotent()`** |
| **Transactional Rollback** | ❌ Per-file writes | ❌ None | ❌ Direct disk save | ✅ **Staged writes + Automatic Rollback** |

---

## Requirements

- **TypeScript**: 7.0 or higher (minimum requirement)
- **Node.js**: 24 or higher

---

## Installation

```sh
pnpm add -D safemods effect typescript@7
```

`effect` and TypeScript 7 are installed as direct dependencies of `safemods`.

---

## Quick Example: API Migration Recipe

A recipe finds nodes in your project, drafts replacements, and declares verification policies.

```ts
import { Effect } from "effect"
import { isObjectLiteralExpression } from "typescript/unstable/ast/is"
import {
  ConfiguredProject,
  Draft,
  Policy,
  Query,
  Recipe,
  WorkspaceSnapshot,
} from "safemods"

// 1. Declare the project boundary
const app = ConfiguredProject.make({
  id: "app",
  config: "tsconfig.json",
})

export default Recipe.define("wrap-target-input", {
  version: "1.0.0",

  // 2. Declarative Verification Policies
  policies: [
    Policy.matches({ min: 1 }), // Guard against 0-match silent runs
    Policy.noNewErrors(),       // Reject if any new TS error is introduced
    Policy.idempotent(),        // Re-running against output must yield 0 edits
  ],

  // 3. Transformation Logic
  run: () =>
    Effect.gen(function* () {
      const snapshot = yield* WorkspaceSnapshot
      const project = yield* snapshot.project(app)

      // Resolve the exact declaration symbol across imports and re-exports
      const targetSymbol = yield* project.symbolNamed("target", {
        within: "src/library.ts",
      })

      // Query call sites resolving strictly to targetSymbol
      const calls = yield* Query.calls(project).pipe(
        Query.where(
          Query.resolvesTo(targetSymbol, {
            location: (call) => call.expression,
          }),
        ),
        Query.filter(
          ({ value: call }) =>
            call.arguments.length === 1 &&
            !isObjectLiteralExpression(call.arguments[0]!),
        ),
        Query.collect,
      )

      // Draft range-guarded replacements
      return yield* Draft.replaceEach(calls, ({ value: call }) => {
        const argument = call.arguments[0]!
        return {
          node: argument,
          text: `{ value: ${argument.getText()} }`,
        }
      })
    }),
})
```

---

## Core Capabilities

### 1. In-Memory Multi-Phase Overlays (`snapshot.overlay`)
Multi-phase transformations (e.g. migrating an exported function signature in a library and subsequently refactoring downstream call sites across consuming files) run inside a virtual compiler overlay without writing intermediate states to disk:

```ts
import { Draft, overlay, WorkspaceSnapshot } from "safemods"

// Phase 1: Update declaration in library.ts
const draft1 = yield* Draft.imports.addNamed(project, "src/library.ts", {
  module: "./types.js",
  name: "NewConfig",
})

// Phase 2: Query downstream files inside the compiler overlay
return yield* overlay(draft1, Effect.gen(function* () {
  const overlaySnapshot = yield* WorkspaceSnapshot
  const overlayProject = yield* overlaySnapshot.project(app)
  // Downstream files now see NewConfig resolved by TypeScript!
  return yield* Draft.concat(draft1, /* Phase 2 edits */)
}))
```

### 2. High-Fidelity Syntactic Draft Combinators
All syntactic operations operate on minimal range slices guarded by cryptographic old-text hashes, preserving indentation, comments, and project formatting:

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

### 3. Declarative Policy Engine
Enforce strict invariants across the entire workspace before any files are modified:

- **`Policy.noNewErrors()`** &mdash; Computes diagnostic diffs (`introduced`, `resolved`, `unchanged`) to guarantee no new compiler errors.
- **`Policy.idempotent()`** &mdash; Replays the recipe against the proposed output to ensure a second run produces zero further edits.
- **`Policy.matches({ min, max })` / `Policy.exactly(n)`** &mdash; Guardrails against over- or under-matching.
- **`Policy.atMostFiles(n)`** &mdash; Caps the affected file blast radius.
- **`Policy.fixesError(code)`** &mdash; Asserts that specific TypeScript diagnostic codes are actively resolved.

### 4. Transactional Writes with Automatic Rollback
`PlanApplication` is strictly isolated from planning:
1. Re-validates source file hashes to prevent applying against stale files (`StalePlanError`).
2. Stages changes to temporary files (`${file}.safemods-${uuid}.tmp`).
3. Commits changes via atomic filesystem renames.
4. If any failure occurs during writing or renaming, all staged files are cleaned up, modified files are restored from their original contents, and `rolledBack: true` is reported.

---

## CLI

```sh
# 1. Preview colored diffs in terminal (Read-Only)
safemods run ./recipe.ts --cwd ./my-project

# 2. Run in-memory compiler verification without writing to disk
safemods run ./recipe.ts --cwd ./my-project --verify

# 3. Verify and atomically apply changes with rollback protection
safemods run ./recipe.ts --cwd ./my-project --apply
```

### Parametric Recipes & AI Agent Tool Calling
Recipes can accept typed parameters using `@effect/schema` and export structured schemas for AI coding agents:

```sh
# Run with JSON input
safemods run ./recipe.ts --cwd ./my-project --input '{"key": "value"}'

# Export JSON Schema for LLM tool calling
safemods tool ./recipe.ts
```

---

## Programmatic Usage

Recipes can also be executed directly within an Effect workflow:

```ts
import { Recipe, Preview, Verification, Application } from "safemods"

const pipeline = Effect.gen(function* () {
  // 1. Build immutable transformation plan
  const plan = yield* Recipe.run(myRecipe, input)

  // 2. Materialize exact proposed bytes without writing
  const preview = yield* Preview.of(plan)

  // 3. Verify in-memory compiler diagnostics and policies
  const verified = yield* Verification.verify(plan, myRecipe, input)

  // 4. Staged atomic filesystem commit with rollback
  const receipt = yield* Application.apply(verified)
  return receipt
})
```

---

## Development

```sh
pnpm check
pnpm test
```

### Examples & References

- [API Tour](./examples/declarative-api-tour.ts) &mdash; Comprehensive walkthrough of available queries and combinators.
- [Examples Guide](./examples/README.md) &mdash; In-depth architectural tour and pattern examples.
- [Context & Architecture](./CONTEXT.md) &mdash; Project terminology and architectural model.
