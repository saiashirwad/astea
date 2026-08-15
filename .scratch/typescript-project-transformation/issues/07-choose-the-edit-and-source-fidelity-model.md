# Choose the edit and source-fidelity model

Type: prototype
Status: resolved
Blocked by: 02, 03, 04

## Comments

- Claimed after the identity decision to prototype the canonical edit algebra, conflict rules, source preservation, and native fragment printing.

## Question

What representation should a Transformation Plan use for replacements, insertions, removals, renames, imports, and synthesized fragments? Prototype minimal range edits, native hybrid AST printing, parsed templates, and available compiler refactors; decide how comments, trivia, unrelated formatting, edit overlap, and composability are preserved or rejected.

## Answer

The one canonical plan primitive is a guarded text edit: Configured Project, project-relative file, half-open source range, replacement text, expected hash of the old text, and evidence. Replacement, insertion, and removal are respectively non-empty range plus text, empty range plus text, and non-empty range plus empty text. Rename, import management, and other conveniences are recipe operations that compile to these primitives; they are not alternative edit representations.

Edits are sorted by project, file, start, end, and replacement text. Invalid ranges, overlapping ranges, insertions within or on the boundary of another edit, and two insertions at the same position are rejected. A future composition combinator may intentionally merge such operations before finalization, but a finalized plan can contain no ambiguous ordering. Before preview, verification, or application, every edit's expected old-text hash must match.

Minimal edits are the source-fidelity boundary. Applying them from the end of a file toward the beginning proves every byte outside the selected ranges remains identical, including newline style, comments, whitespace, and unrelated formatting. Node replacement defaults to `node.getStart(sourceFile)..node.getEnd()`, preserving leading trivia; callers must deliberately widen the range if they intend to replace attached comments. Comments inside a replaced range are not silently recovered—the preview exposes their removal.

The native TypeScript 7 emitter is used to print synthesized or updated AST fragments, and that printed fragment is then placed through an ordinary guarded text edit. The prototype proves hybrid printing works. The currently exposed `typescript/unstable/async` surface does not expose a general parser/template API or language-service refactor/code-fix API. Parsed templates and compiler-authored refactors therefore remain optional authoring conveniences to revisit only if the native API exposes them; raw template text is acceptable today, while factories plus the native emitter are the typed construction path. Neither gap changes the plan representation.

Prototype: [`src/prototype/edits.ts`](../../../src/prototype/edits.ts) and [`src/prototype/edits.test.ts`](../../../src/prototype/edits.test.ts).
