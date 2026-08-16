/**
 * Candidate public API — the Draft Plan.
 *
 * A Draft is an immutable value: the edits a recipe proposes plus the
 * evidence that explains them and the primary-run match measurement. Authors
 * never compute ranges, hashes, file identity, or evidence IDs — every edit
 * is declared against a native node or a Selection, and the builder derives
 * the durable guard data from the snapshot. Finalization (ordering, conflict
 * rejection, plan identity) belongs to the engine in `Recipe.run`.
 */
import { Effect } from "effect"
import type {
  CallExpression,
  ImportDeclaration,
  Node,
  ObjectLiteralExpression,
  SourceFile,
} from "typescript/unstable/ast"
import {
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
} from "typescript/unstable/ast/is"
import { textHash } from "../prototype/edits.ts"
import { type NativeCompilerError, nativeRequest } from "../prototype/native-compiler.ts"
import type { EvidenceRecord, PlannedTextEdit } from "../prototype/plan.ts"
import { projectRelativePath } from "../prototype/project-path.ts"
import type { Selection } from "./query.ts"
import type { FileNotFound, ProjectSnapshot, ProjectSnapshotError, SnapshotExpired } from "./workspace.ts"

/** An edit in pre-finalization form; identical in shape to its durable counterpart. */
export type ProposedEdit = PlannedTextEdit

export interface Draft {
  readonly edits: ReadonlyArray<ProposedEdit>
  readonly evidence: ReadonlyArray<EvidenceRecord>
  /** Number of selections that produced this draft; recorded as a planning-time measurement. */
  readonly matches: number
}

export const empty: Draft = { edits: [], evidence: [], matches: 0 }

/** Combine drafts built from disjoint selections. Conflicting overlaps are rejected at finalization. */
export const concat = (...drafts: ReadonlyArray<Draft>): Draft => ({
  edits: drafts.flatMap((draft) => [...draft.edits]),
  evidence: drafts.flatMap((draft) => [...draft.evidence]),
  matches: drafts.reduce((total, draft) => total + draft.matches, 0),
})

export interface EditRangeOptions {
  readonly includeLeadingTrivia?: boolean
}

const editForNode = (
  project: ProjectSnapshot,
  node: Node,
  newText: string,
  options?: EditRangeOptions & { readonly evidenceIds?: ReadonlyArray<string> },
): Effect.Effect<ProposedEdit, SnapshotExpired> =>
  project.unsafeNative(() =>
    Effect.sync(() => {
      const sourceFile = node.getSourceFile()
      const start = options?.includeLeadingTrivia === true ? node.getFullStart() : node.getStart(sourceFile)
      const end = node.getEnd()
      return {
        projectId: project.project.id,
        fileName: projectRelativePath(project.root, sourceFile.fileName),
        start,
        end,
        expectedTextHash: textHash(sourceFile.text.slice(start, end)),
        newText,
        evidenceIds: options?.evidenceIds ?? [],
      }
    })
  )

const draftOf = (edit: Effect.Effect<ProposedEdit, SnapshotExpired>, evidence: ReadonlyArray<EvidenceRecord>, matches: number) =>
  Effect.map(edit, (proposed): Draft => ({ edits: [proposed], evidence, matches }))

/** Replace a node's source range with new text. */
export const replace = (
  project: ProjectSnapshot,
  node: Node,
  newText: string,
  options?: EditRangeOptions,
): Effect.Effect<Draft, SnapshotExpired> => draftOf(editForNode(project, node, newText, options), [], 0)

/** Remove a node's source range entirely. */
export const remove = (
  project: ProjectSnapshot,
  node: Node,
  options?: EditRangeOptions,
): Effect.Effect<Draft, SnapshotExpired> => replace(project, node, "", options)

/** Insert text immediately before a node's first token. */
export const insertBefore = (
  project: ProjectSnapshot,
  node: Node,
  text: string,
): Effect.Effect<Draft, SnapshotExpired> => insertAtNode(project, node, text, "before")

/** Insert text immediately after a node's end. */
export const insertAfter = (
  project: ProjectSnapshot,
  node: Node,
  text: string,
): Effect.Effect<Draft, SnapshotExpired> => insertAtNode(project, node, text, "after")

const insertAtNode = (
  project: ProjectSnapshot,
  node: Node,
  text: string,
  side: "before" | "after",
): Effect.Effect<Draft, SnapshotExpired> =>
  project.unsafeNative(() =>
    Effect.sync((): Draft => {
      const sourceFile = node.getSourceFile()
      const position = side === "before" ? node.getStart(sourceFile) : node.getEnd()
      return {
        edits: [{
          projectId: project.project.id,
          fileName: projectRelativePath(project.root, sourceFile.fileName),
          start: position,
          end: position,
          expectedTextHash: textHash(""),
          newText: text,
          evidenceIds: [],
        }],
        evidence: [],
        matches: 0,
      }
    })
  )

/** Print a synthesized or updated native node to source text via the native emitter. */
export const print = (
  project: ProjectSnapshot,
  node: Node,
): Effect.Effect<string, NativeCompilerError | SnapshotExpired> =>
  project.unsafeNative((nativeProject) =>
    nativeRequest("print native fragment", () => nativeProject.emitter.printNode(node))
  )

/** Replace a node with a printed native fragment (e.g. built with the native factory API). */
export const replaceWith = (
  project: ProjectSnapshot,
  node: Node,
  fragment: Node,
  options?: EditRangeOptions,
): Effect.Effect<Draft, NativeCompilerError | SnapshotExpired> =>
  print(project, fragment).pipe(Effect.flatMap((text) => replace(project, node, text, options)))

/** The replacement a selection maps to: text only (replace the selected node) or an explicit target node. */
export type Replacement = string | { readonly node: Node; readonly text: string }

/**
 * Propose one replacement per selection. Each edit inherits its selection's
 * Query Evidence automatically; the draft records the selection count as the
 * primary-run match measurement.
 */
export const replaceEach = <A extends Node>(
  selections: ReadonlyArray<Selection<A>>,
  replacement: (selection: Selection<A>) => Replacement,
): Effect.Effect<Draft, SnapshotExpired> =>
  Effect.forEach(selections, (selection) => {
    const proposed = replacement(selection)
    const node = typeof proposed === "string" ? selection.value : proposed.node
    const text = typeof proposed === "string" ? proposed : proposed.text
    const evidenceId =
      `selection:${selection.project.project.id}:${selection.fileName}:${selection.start}`
    return editForNode(selection.project, node, text, { evidenceIds: [evidenceId] }).pipe(
      Effect.map((edit): Draft => ({
        edits: [edit],
        evidence: [{
          id: evidenceId,
          kind: "selection",
          facts: {
            fileName: selection.fileName,
            start: selection.start,
            end: selection.end,
            criteria: selection.evidence.map((item) => ({
              criterion: item.criterion,
              facts: { ...item.facts },
            })),
          },
        }],
        matches: 1,
      })),
    )
  }).pipe(Effect.map((drafts) => concat(...drafts)))

// -----------------------------------------------------------------------------
// High-Fidelity Syntactic Draft Combinators
// -----------------------------------------------------------------------------

const detectQuoteStyle = (sourceFile: SourceFile): '"' | "'" => {
  for (const stmt of sourceFile.statements) {
    if (isImportDeclaration(stmt) && isStringLiteral(stmt.moduleSpecifier)) {
      const raw = stmt.moduleSpecifier.getText(sourceFile)
      if (raw.startsWith("'")) return "'"
      if (raw.startsWith('"')) return '"'
    }
  }
  return '"'
}

/** Import management draft combinators. */
export const imports = {
  /** Add a named import to a file, merging into existing import declarations if present. */
  addNamed: (
    project: ProjectSnapshot,
    fileName: string,
    options: {
      readonly module: string
      readonly name: string
      readonly alias?: string
    },
  ): Effect.Effect<Draft, FileNotFound | ProjectSnapshotError> =>
    Effect.gen(function*() {
      const sourceFile = yield* project.sourceFile(fileName)
      if (sourceFile === undefined) {
        return yield* Effect.succeed(empty)
      }

      const quote = detectQuoteStyle(sourceFile)
      const specifierText = options.alias !== undefined
        ? `${options.name} as ${options.alias}`
        : options.name

      let existingDecl: ImportDeclaration | undefined
      for (const stmt of sourceFile.statements) {
        if (
          isImportDeclaration(stmt) &&
          isStringLiteral(stmt.moduleSpecifier) &&
          stmt.moduleSpecifier.text === options.module
        ) {
          existingDecl = stmt
          break
        }
      }

      if (existingDecl !== undefined && existingDecl.importClause !== undefined) {
        const clause = existingDecl.importClause
        if (clause.namedBindings !== undefined && isNamedImports(clause.namedBindings)) {
          const alreadyImported = clause.namedBindings.elements.some((el) => el.name.text === (options.alias ?? options.name))
          if (alreadyImported) return empty

          if (clause.namedBindings.elements.length > 0) {
            const lastElement = clause.namedBindings.elements[clause.namedBindings.elements.length - 1]!
            const insertPos = lastElement.getEnd()
            const edit: ProposedEdit = {
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: `, ${specifierText}`,
              evidenceIds: [`import:add:${options.module}:${options.name}`],
            }
            return { edits: [edit], evidence: [], matches: 1 }
          } else {
            const insertPos = clause.namedBindings.getStart(sourceFile) + 1
            const edit: ProposedEdit = {
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: ` ${specifierText} `,
              evidenceIds: [`import:add:${options.module}:${options.name}`],
            }
            return { edits: [edit], evidence: [], matches: 1 }
          }
        }
      }

      // No matching import declaration — insert new import statement
      let insertPos = 0
      let prefix = ""
      let suffix = "\n"

      let lastImport: ImportDeclaration | undefined
      for (const stmt of sourceFile.statements) {
        if (isImportDeclaration(stmt)) {
          lastImport = stmt
        }
      }

      if (lastImport !== undefined) {
        insertPos = lastImport.getEnd()
        prefix = "\n"
        suffix = ""
      }

      const importStatement = `${prefix}import { ${specifierText} } from ${quote}${options.module}${quote}${suffix}`
      const edit: ProposedEdit = {
        projectId: project.project.id,
        fileName: projectRelativePath(project.root, sourceFile.fileName),
        start: insertPos,
        end: insertPos,
        expectedTextHash: textHash(""),
        newText: importStatement,
        evidenceIds: [`import:new:${options.module}:${options.name}`],
      }
      return { edits: [edit], evidence: [], matches: 1 }
    }),

  /** Remove a named import from a file. */
  removeNamed: (
    project: ProjectSnapshot,
    fileName: string,
    options: {
      readonly module: string
      readonly name: string
    },
  ): Effect.Effect<Draft, FileNotFound | ProjectSnapshotError> =>
    Effect.gen(function*() {
      const sourceFile = yield* project.sourceFile(fileName)
      if (sourceFile === undefined) return empty

      for (const stmt of sourceFile.statements) {
        if (
          isImportDeclaration(stmt) &&
          isStringLiteral(stmt.moduleSpecifier) &&
          stmt.moduleSpecifier.text === options.module &&
          stmt.importClause?.namedBindings !== undefined &&
          isNamedImports(stmt.importClause.namedBindings)
        ) {
          const namedBindings = stmt.importClause.namedBindings
          const index = namedBindings.elements.findIndex((el) => el.name.text === options.name)
          if (index === -1) continue

          if (namedBindings.elements.length === 1 && stmt.importClause.name === undefined) {
            // Remove entire import declaration including newline
            let endPos = stmt.getEnd()
            if (sourceFile.text[endPos] === "\n") endPos += 1
            else if (sourceFile.text.slice(endPos, endPos + 2) === "\r\n") endPos += 2

            const startPos = stmt.getStart(sourceFile)
            const edit: ProposedEdit = {
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start: startPos,
              end: endPos,
              expectedTextHash: textHash(sourceFile.text.slice(startPos, endPos)),
              newText: "",
              evidenceIds: [`import:remove:${options.module}:${options.name}`],
            }
            return { edits: [edit], evidence: [], matches: 1 }
          } else {
            // Remove single element from named bindings
            const el = namedBindings.elements[index]!
            let start = el.getStart(sourceFile)
            let end = el.getEnd()

            if (index < namedBindings.elements.length - 1) {
              const nextEl = namedBindings.elements[index + 1]!
              end = nextEl.getStart(sourceFile)
            } else if (index > 0) {
              const prevEl = namedBindings.elements[index - 1]!
              start = prevEl.getEnd()
            }

            const edit: ProposedEdit = {
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start,
              end,
              expectedTextHash: textHash(sourceFile.text.slice(start, end)),
              newText: "",
              evidenceIds: [`import:remove:${options.module}:${options.name}`],
            }
            return { edits: [edit], evidence: [], matches: 1 }
          }
        }
      }

      return empty
    }),

  /** Update module specifier path in an import declaration. */
  updateSource: (
    project: ProjectSnapshot,
    importDeclaration: ImportDeclaration,
    newModule: string,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const specifier = importDeclaration.moduleSpecifier
        const sourceFile = importDeclaration.getSourceFile()
        const text = specifier.getText(sourceFile)
        const quote = text.startsWith("'") ? "'" : '"'
        const newSpecifierText = `${quote}${newModule}${quote}`
        const start = specifier.getStart(sourceFile)
        const end = specifier.getEnd()

        return {
          edits: [{
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start,
            end,
            expectedTextHash: textHash(sourceFile.text.slice(start, end)),
            newText: newSpecifierText,
            evidenceIds: [`import:update-source:${newModule}`],
          }],
          evidence: [],
          matches: 1,
        }
      })
    ),
}

/** Function call argument rewriting combinators. */
export const args = {
  /** Wrap a call argument with new text. */
  wrap: (
    project: ProjectSnapshot,
    call: CallExpression,
    index: number,
    transform: (argumentText: string, argumentNode: Node) => string,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const argument = call.arguments[index]
        if (argument === undefined) return empty
        const sourceFile = call.getSourceFile()
        const start = argument.getStart(sourceFile)
        const end = argument.getEnd()
        const currentText = sourceFile.text.slice(start, end)
        const newText = transform(currentText, argument)

        return {
          edits: [{
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start,
            end,
            expectedTextHash: textHash(currentText),
            newText,
            evidenceIds: [`argument:wrap:${index}`],
          }],
          evidence: [],
          matches: 1,
        }
      })
    ),

  /** Reorder call arguments by index array. */
  reorder: (
    project: ProjectSnapshot,
    call: CallExpression,
    indices: ReadonlyArray<number>,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        if (call.arguments.length === 0 || indices.length !== call.arguments.length) {
          return empty
        }
        const sourceFile = call.getSourceFile()
        const firstArg = call.arguments[0]!
        const lastArg = call.arguments[call.arguments.length - 1]!
        const start = firstArg.getStart(sourceFile)
        const end = lastArg.getEnd()
        const originalSlice = sourceFile.text.slice(start, end)

        const orderedTexts = indices.map((idx) => {
          const arg = call.arguments[idx]!
          return sourceFile.text.slice(arg.getStart(sourceFile), arg.getEnd())
        })

        return {
          edits: [{
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start,
            end,
            expectedTextHash: textHash(originalSlice),
            newText: orderedTexts.join(", "),
            evidenceIds: ["argument:reorder"],
          }],
          evidence: [],
          matches: 1,
        }
      })
    ),

  /** Append an argument to a call expression. */
  append: (
    project: ProjectSnapshot,
    call: CallExpression,
    text: string,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const sourceFile = call.getSourceFile()
        if (call.arguments.length === 0) {
          const callEnd = call.getEnd()
          const insertPos = callEnd - 1
          return {
            edits: [{
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: text,
              evidenceIds: ["argument:append"],
            }],
            evidence: [],
            matches: 1,
          }
        } else {
          const lastArg = call.arguments[call.arguments.length - 1]!
          const insertPos = lastArg.getEnd()
          return {
            edits: [{
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: `, ${text}`,
              evidenceIds: ["argument:append"],
            }],
            evidence: [],
            matches: 1,
          }
        }
      })
    ),
}

/** Object literal editing combinators. */
export const objectLiteral = {
  /** Set or insert a property in an ObjectLiteralExpression. */
  setField: (
    project: ProjectSnapshot,
    literal: ObjectLiteralExpression,
    fieldName: string,
    valueText: string,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const sourceFile = literal.getSourceFile()
        for (const prop of literal.properties) {
          if (isPropertyAssignment(prop)) {
            const name = isIdentifier(prop.name) || isStringLiteral(prop.name) ? prop.name.text : ""
            if (name === fieldName) {
              const init = prop.initializer
              const start = init.getStart(sourceFile)
              const end = init.getEnd()
              return {
                edits: [{
                  projectId: project.project.id,
                  fileName: projectRelativePath(project.root, sourceFile.fileName),
                  start,
                  end,
                  expectedTextHash: textHash(sourceFile.text.slice(start, end)),
                  newText: valueText,
                  evidenceIds: [`object:setField:${fieldName}`],
                }],
                evidence: [],
                matches: 1,
              }
            }
          }
        }

        // Insert new property before closing brace
        const insertPos = literal.getEnd() - 1
        const prefix = literal.properties.length > 0 ? ", " : " "
        const suffix = literal.properties.length === 0 ? " " : ""
        const textToInsert = `${prefix}${fieldName}: ${valueText}${suffix}`

        return {
          edits: [{
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start: insertPos,
            end: insertPos,
            expectedTextHash: textHash(""),
            newText: textToInsert,
            evidenceIds: [`object:setField:${fieldName}`],
          }],
          evidence: [],
          matches: 1,
        }
      })
    ),

  /** Remove a property from an ObjectLiteralExpression. */
  removeField: (
    project: ProjectSnapshot,
    literal: ObjectLiteralExpression,
    fieldName: string,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const sourceFile = literal.getSourceFile()
        for (let i = 0; i < literal.properties.length; i++) {
          const prop = literal.properties[i]!
          if (isPropertyAssignment(prop)) {
            const name = isIdentifier(prop.name) || isStringLiteral(prop.name) ? prop.name.text : ""
            if (name === fieldName) {
              let start = prop.getStart(sourceFile)
              let end = prop.getEnd()
              if (i < literal.properties.length - 1) {
                const nextProp = literal.properties[i + 1]!
                end = nextProp.getStart(sourceFile)
              } else if (i > 0) {
                const prevProp = literal.properties[i - 1]!
                start = prevProp.getEnd()
              }

              return {
                edits: [{
                  projectId: project.project.id,
                  fileName: projectRelativePath(project.root, sourceFile.fileName),
                  start,
                  end,
                  expectedTextHash: textHash(sourceFile.text.slice(start, end)),
                  newText: "",
                  evidenceIds: [`object:removeField:${fieldName}`],
                }],
                evidence: [],
                matches: 1,
              }
            }
          }
        }
        return empty
      })
    ),
}

export const Draft = {
  empty,
  concat,
  replace,
  replaceWith,
  remove,
  insertBefore,
  insertAfter,
  print,
  replaceEach,
  imports,
  args,
  objectLiteral,
}
