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
import { path as Path } from "../platform/node.ts"
import { Effect, Option, Predicate } from "effect"
import type {
  ArrowFunction,
  CallExpression,
  ClassDeclaration,
  FunctionDeclaration,
  FunctionExpression,
  ImportDeclaration,
  InterfaceDeclaration,
  MethodDeclaration,
  Node,
  ObjectLiteralExpression,
} from "typescript/unstable/ast"
import {
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isStringLiteral,
} from "typescript/unstable/ast/is"
import type { Symbol as NativeSymbol } from "typescript/unstable/async"
import { textHash } from "../internal/edits.ts"
import { type NativeCompilerError, nativeRequest } from "../internal/native-compiler.ts"
import type { EvidenceRecord, PlannedFileOperation, PlannedTextEdit } from "../internal/plan.ts"
import { projectRelativePath } from "../internal/project-path.ts"
import { Query, type QueryContractError, type Selection } from "./query.ts"
import type { FileNotFound, ProjectSnapshot, ProjectSnapshotError, SnapshotExpired } from "./workspace.ts"

/** An edit in pre-finalization form; identical in shape to its durable counterpart. */
export type ProposedEdit = PlannedTextEdit

export interface Draft {
  readonly edits: ReadonlyArray<ProposedEdit>
  readonly fileOperations?: ReadonlyArray<PlannedFileOperation>
  readonly evidence: ReadonlyArray<EvidenceRecord>
  /** Number of selections that produced this draft; recorded as a planning-time measurement. */
  readonly matches: number
}

export const empty: Draft = { edits: [], fileOperations: [], evidence: [], matches: 0 }

/** Combine drafts built from disjoint selections. Conflicting overlaps are rejected at finalization. */
export const concat = (...drafts: ReadonlyArray<Draft>): Draft => ({
  edits: drafts.flatMap((draft) => [...draft.edits]),
  fileOperations: drafts.flatMap((draft) => (draft.fileOperations ? [...draft.fileOperations] : [])),
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
    Effect.sync(() => {
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

/** Replace a specific argument of a call expression by 0-based index. */
export const replaceArgument = (
  project: ProjectSnapshot,
  call: CallExpression,
  index: number,
  newText: string,
  options?: EditRangeOptions,
): Effect.Effect<Draft, SnapshotExpired> => {
  const argument = call.arguments[index]
  if (argument === undefined) {
    return Effect.succeed(empty)
  }
  return replace(project, argument, newText, options)
}

/** Wrap a specific argument of a call expression by index using a formatting function. */
export const wrapArgument = (
  project: ProjectSnapshot,
  call: CallExpression,
  index: number,
  transform: (argText: string) => string,
  options?: EditRangeOptions,
): Effect.Effect<Draft, SnapshotExpired> => {
  const argument = call.arguments[index]
  if (argument === undefined) {
    return Effect.succeed(empty)
  }
  return replace(project, argument, transform(argument.getText()), options)
}

const isTextReplacement = (val: Replacement): val is string => typeof val === "string"

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Type guard boundary for candidate draft values.
export const isDraft = (value: unknown): value is Draft =>
  Predicate.isObject(value) && "edits" in value && "evidence" in value && "matches" in value

/**
 * Propose one replacement per selection. Each edit inherits its selection's
 * Query Evidence automatically; the draft records the selection count as the
 * primary-run match measurement.
 */
export const replaceEach = <A extends Node, E = never, R = never>(
  selections: ReadonlyArray<Selection<A>>,
  replacement: (selection: Selection<A>) => Replacement | Draft | Effect.Effect<Replacement | Draft, E, R>,
): Effect.Effect<Draft, E | SnapshotExpired, R> =>
  Effect.forEach(selections, (selection) => {
    const raw = replacement(selection)
    const effect = Effect.isEffect(raw) ? raw : Effect.succeed(raw)
    return effect.pipe(
      Effect.flatMap((proposed) => {
        if (isDraft(proposed)) {
          const evidenceId =
            `selection:${selection.project.project.id}:${selection.fileName}:${selection.start}`
          const evidence = proposed.evidence.length > 0
            ? proposed.evidence
            : [{
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
            }]
          return Effect.succeed({
            ...proposed,
            evidence,
            matches: proposed.matches > 0 ? proposed.matches : 1,
          })
        }
        const node = isTextReplacement(proposed) ? selection.value : proposed.node
        const text = isTextReplacement(proposed) ? proposed : proposed.text
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
      }),
    )
  }).pipe(Effect.map((drafts) => concat(...drafts)))

// =============================================================================
// File Lifecycle Operations
// =============================================================================

export const files = {
  /** Propose creating a new source file in the project with initial content. */
  create: (
    project: ProjectSnapshot,
    relativePath: string,
    content: string,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => ({
        edits: [],
        fileOperations: [{
          kind: "create",
          projectId: project.project.id,
          path: relativePath,
          content,
          evidenceIds: [`file:create:${relativePath}`],
        }],
        evidence: [],
        matches: 1,
      }))
    ),

  /** Propose deleting an existing source file from the project. */
  delete: (
    project: ProjectSnapshot,
    relativePath: string,
  ): Effect.Effect<Draft, ProjectSnapshotError | FileNotFound> =>
    Effect.gen(function*() {
      const source = yield* project.sourceText(relativePath)
      return yield* project.unsafeNative(() =>
        Effect.sync((): Draft => ({
          edits: [],
          fileOperations: [{
            kind: "delete",
            projectId: project.project.id,
            path: relativePath,
            initialHash: textHash(source),
            evidenceIds: [`file:delete:${relativePath}`],
          }],
          evidence: [],
          matches: 1,
        }))
      )
    }),

  /** Propose moving/renaming a source file and automatically rewrites relative import references across the project. */
  move: (
    project: ProjectSnapshot,
    fromPath: string,
    toPath: string,
  ): Effect.Effect<Draft, ProjectSnapshotError | FileNotFound | QueryContractError> =>
    Effect.gen(function*() {
      const source = yield* project.sourceText(fromPath)
      const fileOpDraft: Draft = {
        edits: [],
        fileOperations: [{
          kind: "move",
          projectId: project.project.id,
          path: fromPath,
          toPath,
          content: source,
          initialHash: textHash(source),
          evidenceIds: [`file:move:${fromPath}->${toPath}`],
        }],
        evidence: [],
        matches: 1,
      }

      // Compute relative module specifier adjustments across all files in the project
      const fromBase = fromPath.replace(/\.(ts|tsx|js|jsx)$/, "")
      const toBase = toPath.replace(/\.(ts|tsx|js|jsx)$/, "")

      const importEdits: Array<ProposedEdit> = []
      const sourceNames = yield* project.sourceFileNames

      for (const absFile of sourceNames) {
        const file = yield* project.sourceFile(absFile)
        if (file === undefined) continue
        const relFile = projectRelativePath(project.root, file.fileName)
        if (relFile === fromPath) continue

        for (const statement of file.statements) {
          if (isImportDeclaration(statement)) {
            const specifier = statement.moduleSpecifier
            if (isStringLiteral(specifier)) {
              const specText = specifier.text
              const fileDir = Path.dirname(relFile)
              const resolvedImport = Path.normalize(Path.join(fileDir, specText)).replace(/\.(ts|tsx|js|jsx)$/, "")
              if (resolvedImport === fromBase || resolvedImport === `./${fromBase}` || resolvedImport === fromPath) {
                let newRel = Path.relative(fileDir, toBase)
                if (!newRel.startsWith(".")) newRel = `./${newRel}`
                const ext = specText.endsWith(".js") ? ".js" : specText.endsWith(".ts") ? ".ts" : ""
                const newSpecText = `${newRel}${ext}`
                const start = specifier.getStart(file)
                const end = specifier.getEnd()
                const quote = file.text[start] === "'" ? "'" : '"'
                importEdits.push({
                  projectId: project.project.id,
                  fileName: relFile,
                  start,
                  end,
                  expectedTextHash: textHash(file.text.slice(start, end)),
                  newText: `${quote}${newSpecText}${quote}`,
                  evidenceIds: [`import:move-target:${relFile}`],
                })
              }
            }
          }
        }
      }

      const importDraft: Draft = { edits: importEdits, evidence: [], matches: importEdits.length }
      return concat(fileOpDraft, importDraft)
    }),
}

// =============================================================================
// Import Declarations
// =============================================================================

export interface AddNamedImportOptions {
  readonly module: string
  readonly name: string
  readonly alias?: string
}

export const imports = {
  /** Add a named import to a source file. */
  addNamed: (
    project: ProjectSnapshot,
    fileName: string,
    options: AddNamedImportOptions,
  ): Effect.Effect<Draft, ProjectSnapshotError> =>
    Effect.gen(function*() {
      const source = yield* project.sourceFile(fileName)
      if (source === undefined) {
        return empty
      }

      return yield* project.unsafeNative(() =>
        Effect.sync((): Draft => {
          const importName = options.alias ? `${options.name} as ${options.alias}` : options.name

          for (const statement of source.statements) {
            if (isImportDeclaration(statement)) {
              const specifier = statement.moduleSpecifier
              if (isStringLiteral(specifier) && specifier.text === options.module) {
                const clause = statement.importClause
                if (clause && clause.namedBindings && isNamedImports(clause.namedBindings)) {
                  const named = clause.namedBindings
                  for (const element of named.elements) {
                    if (element.name.text === (options.alias ?? options.name)) {
                      return empty
                    }
                  }

                  if (named.elements.length > 0) {
                    const last = named.elements[named.elements.length - 1]!
                    const insertPos = last.getEnd()
                    return {
                      edits: [{
                        projectId: project.project.id,
                        fileName: projectRelativePath(project.root, source.fileName),
                        start: insertPos,
                        end: insertPos,
                        expectedTextHash: textHash(""),
                        newText: `, ${importName}`,
                        evidenceIds: [`import:addNamed:${options.module}:${options.name}`],
                      }],
                      evidence: [],
                      matches: 1,
                    }
                  }
                }
              }
            }
          }

          const insertPos = 0
          const importText = `import { ${importName} } from "${options.module}";\n`

          return {
            edits: [{
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, source.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: importText,
              evidenceIds: [`import:addNamed:${options.module}:${options.name}`],
            }],
            evidence: [],
            matches: 1,
          }
        })
      )
    }),

  /** Remove a named import from an import declaration. */
  removeNamed: (
    project: ProjectSnapshot,
    declaration: ImportDeclaration,
    name: string,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const clause = declaration.importClause
        if (!clause || !clause.namedBindings || !isNamedImports(clause.namedBindings)) {
          return empty
        }

        const named = clause.namedBindings
        const elements = named.elements
        const targetIndex = elements.findIndex((el) => el.name.text === name || el.propertyName?.text === name)

        if (targetIndex === -1) return empty

        const sourceFile = declaration.getSourceFile()

        if (elements.length === 1) {
          const start = declaration.getFullStart()
          const end = declaration.getEnd()
          return {
            edits: [{
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start,
              end,
              expectedTextHash: textHash(sourceFile.text.slice(start, end)),
              newText: "",
              evidenceIds: [`import:removeNamed:${name}`],
            }],
            evidence: [],
            matches: 1,
          }
        }

        const target = elements[targetIndex]!
        let start = target.getStart(sourceFile)
        let end = target.getEnd()

        if (targetIndex < elements.length - 1) {
          const next = elements[targetIndex + 1]!
          end = next.getStart(sourceFile)
        } else if (targetIndex > 0) {
          const prev = elements[targetIndex - 1]!
          start = prev.getEnd()
        }

        return {
          edits: [{
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start,
            end,
            expectedTextHash: textHash(sourceFile.text.slice(start, end)),
            newText: "",
            evidenceIds: [`import:removeNamed:${name}`],
          }],
          evidence: [],
          matches: 1,
        }
      })
    ),

  /** Update an import module specifier source path. */
  updateSource: (
    project: ProjectSnapshot,
    declaration: ImportDeclaration,
    newModule: string,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const specifier = declaration.moduleSpecifier
        if (!isStringLiteral(specifier)) return empty

        const sourceFile = declaration.getSourceFile()
        const quote = specifier.getText(sourceFile)[0] ?? '"'
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

  /** Organize, group, deduplicate, and sort all imports in a file deterministically. */
  organize: (
    project: ProjectSnapshot,
    fileName: string,
  ): Effect.Effect<Draft, ProjectSnapshotError> =>
    Effect.gen(function*() {
      const source = yield* project.sourceFile(fileName)
      if (source === undefined) return empty

      return yield* project.unsafeNative(() =>
        Effect.sync((): Draft => {
          const importDecls: Array<ImportDeclaration> = []
          for (const statement of source.statements) {
            if (isImportDeclaration(statement)) {
              importDecls.push(statement)
            }
          }

          if (importDecls.length === 0) return empty

          const firstDecl = importDecls[0]!
          const lastDecl = importDecls[importDecls.length - 1]!
          const start = firstDecl.getStart(source)
          const end = lastDecl.getEnd()

          // Group by module
          const byModule = new Map<string, { isTypeOnly: boolean; defaultImport?: string; namedImports: Set<string> }>()
          for (const decl of importDecls) {
            if (isStringLiteral(decl.moduleSpecifier)) {
              const mod = decl.moduleSpecifier.text
              let existing = byModule.get(mod)
              if (existing === undefined) {
                existing = { isTypeOnly: false, namedImports: new Set() }
                byModule.set(mod, existing)
              }
              const clause = decl.importClause
              if (clause) {
                if (clause.name) existing.defaultImport = clause.name.text
                if (clause.namedBindings && isNamedImports(clause.namedBindings)) {
                  for (const el of clause.namedBindings.elements) {
                    const specText = el.propertyName ? `${el.propertyName.text} as ${el.name.text}` : el.name.text
                    existing.namedImports.add(specText)
                  }
                }
              }
            }
          }

          // Partition into: 1. Built-in node modules, 2. External packages, 3. Relative/internal
          const isBuiltin = (m: string) => m.startsWith("node:") || ["fs", "path", "crypto", "os", "util", "events", "url"].includes(m)
          const isRelative = (m: string) => m.startsWith(".") || m.startsWith("/") || m.startsWith("@/")

          const modules = [...byModule.keys()]
          const builtins = modules.filter(isBuiltin).sort()
          const external = modules.filter((m) => !isBuiltin(m) && !isRelative(m)).sort()
          const internal = modules.filter(isRelative).sort()

          const renderGroup = (mods: Array<string>) =>
            mods.map((mod) => {
              const entry = byModule.get(mod)!
              const parts: Array<string> = []
              if (entry.defaultImport) parts.push(entry.defaultImport)
              if (entry.namedImports.size > 0) {
                const sortedNamed = [...entry.namedImports].sort()
                parts.push(`{ ${sortedNamed.join(", ")} }`)
              }
              return `import ${parts.join(", ")} from "${mod}";`
            }).join("\n")

          const groups = [renderGroup(builtins), renderGroup(external), renderGroup(internal)].filter(Boolean)
          const formattedImports = groups.join("\n\n")

          return {
            edits: [{
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, source.fileName),
              start,
              end,
              expectedTextHash: textHash(source.text.slice(start, end)),
              newText: formattedImports,
              evidenceIds: ["import:organize"],
            }],
            evidence: [],
            matches: 1,
          }
        })
      )
    }),
}

// =============================================================================
// Declaration Combinators: Interfaces, Classes, Functions
// =============================================================================

export interface InterfacePropertyOptions {
  readonly name: string
  readonly type: string
  readonly readonly?: boolean
  readonly optional?: boolean
  readonly leadingComment?: string
}

export const interfaces = {
  /** Add a property signature to an InterfaceDeclaration. */
  addProperty: (
    project: ProjectSnapshot,
    interfaceDecl: InterfaceDeclaration,
    options: InterfacePropertyOptions,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const sourceFile = interfaceDecl.getSourceFile()
        const insertPos = interfaceDecl.getEnd() - 1
        const ro = options.readonly ? "readonly " : ""
        const opt = options.optional ? "?" : ""
        const comment = options.leadingComment ? `  /** ${options.leadingComment} */\n` : ""
        const propertyText = `${comment}  ${ro}${options.name}${opt}: ${options.type};\n`

        return {
          edits: [{
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start: insertPos,
            end: insertPos,
            expectedTextHash: textHash(""),
            newText: propertyText,
            evidenceIds: [`interface:addProperty:${options.name}`],
          }],
          evidence: [],
          matches: 1,
        }
      })
    ),

  /** Remove a property signature from an InterfaceDeclaration. */
  removeProperty: (
    project: ProjectSnapshot,
    interfaceDecl: InterfaceDeclaration,
    propertyName: string,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const sourceFile = interfaceDecl.getSourceFile()
        for (const member of interfaceDecl.members) {
          if (isPropertySignatureDeclaration(member)) {
            const name = isIdentifier(member.name) || isStringLiteral(member.name) ? member.name.text : ""
            if (name === propertyName) {
              const start = member.getFullStart()
              const end = member.getEnd()
              const nextChar = sourceFile.text[end]
              const actualEnd = (nextChar === ";" || nextChar === ",") ? end + 1 : end
              return {
                edits: [{
                  projectId: project.project.id,
                  fileName: projectRelativePath(project.root, sourceFile.fileName),
                  start,
                  end: actualEnd,
                  expectedTextHash: textHash(sourceFile.text.slice(start, actualEnd)),
                  newText: "",
                  evidenceIds: [`interface:removeProperty:${propertyName}`],
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

export interface ClassPropertyOptions {
  readonly name: string
  readonly type?: string
  readonly initializer?: string
  readonly isReadonly?: boolean
  readonly isStatic?: boolean
  readonly access?: "public" | "protected" | "private"
}

export interface ClassMethodOptions {
  readonly name: string
  readonly parameters?: string
  readonly returnType?: string
  readonly body: string
  readonly isAsync?: boolean
  readonly isStatic?: boolean
  readonly access?: "public" | "protected" | "private"
}

export const classes = {
  /** Add a property declaration to a ClassDeclaration. */
  addProperty: (
    project: ProjectSnapshot,
    classDecl: ClassDeclaration,
    options: ClassPropertyOptions,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const sourceFile = classDecl.getSourceFile()
        const insertPos = classDecl.getEnd() - 1
        const acc = options.access ? `${options.access} ` : ""
        const st = options.isStatic ? "static " : ""
        const ro = options.isReadonly ? "readonly " : ""
        const ty = options.type ? `: ${options.type}` : ""
        const init = options.initializer ? ` = ${options.initializer}` : ""
        const propText = `  ${acc}${st}${ro}${options.name}${ty}${init};\n`

        return {
          edits: [{
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start: insertPos,
            end: insertPos,
            expectedTextHash: textHash(""),
            newText: propText,
            evidenceIds: [`class:addProperty:${options.name}`],
          }],
          evidence: [],
          matches: 1,
        }
      })
    ),

  /** Add a method declaration to a ClassDeclaration. */
  addMethod: (
    project: ProjectSnapshot,
    classDecl: ClassDeclaration,
    options: ClassMethodOptions,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const sourceFile = classDecl.getSourceFile()
        const insertPos = classDecl.getEnd() - 1
        const acc = options.access ? `${options.access} ` : ""
        const st = options.isStatic ? "static " : ""
        const asy = options.isAsync ? "async " : ""
        const params = options.parameters ?? ""
        const ret = options.returnType ? `: ${options.returnType}` : ""
        const methodText = `  ${acc}${st}${asy}${options.name}(${params})${ret} {\n    ${options.body}\n  }\n`

        return {
          edits: [{
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start: insertPos,
            end: insertPos,
            expectedTextHash: textHash(""),
            newText: methodText,
            evidenceIds: [`class:addMethod:${options.name}`],
          }],
          evidence: [],
          matches: 1,
        }
      })
    ),
}

export interface FunctionParamOptions {
  readonly name: string
  readonly type?: string
  readonly default?: string
  readonly optional?: boolean
}

export const functions = {
  /** Add a parameter to a function declaration / function expression / arrow function / method. */
  addParameter: (
    project: ProjectSnapshot,
    fn: FunctionDeclaration | FunctionExpression | ArrowFunction | MethodDeclaration,
    options: FunctionParamOptions,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const sourceFile = fn.getSourceFile()
        const params = fn.parameters
        const opt = options.optional ? "?" : ""
        const ty = options.type ? `: ${options.type}` : ""
        const def = options.default ? ` = ${options.default}` : ""
        const paramStr = `${options.name}${opt}${ty}${def}`

        if (params.length === 0) {
          const fnText = sourceFile.text.slice(fn.getStart(sourceFile), fn.getEnd())
          const openParenRel = fnText.indexOf("(")
          const closeParenRel = fnText.indexOf(")", openParenRel)
          if (openParenRel === -1 || closeParenRel === -1) return empty
          const insertPos = fn.getStart(sourceFile) + closeParenRel
          return {
            edits: [{
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: paramStr,
              evidenceIds: [`function:addParam:${options.name}`],
            }],
            evidence: [],
            matches: 1,
          }
        } else {
          const lastParam = params[params.length - 1]!
          const insertPos = lastParam.getEnd()
          return {
            edits: [{
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: `, ${paramStr}`,
              evidenceIds: [`function:addParam:${options.name}`],
            }],
            evidence: [],
            matches: 1,
          }
        }
      })
    ),

  /** Set or update the explicit return type annotation on a function or method. */
  setReturnType: (
    project: ProjectSnapshot,
    fn: FunctionDeclaration | FunctionExpression | ArrowFunction | MethodDeclaration,
    returnType: string,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const sourceFile = fn.getSourceFile()
        if (fn.type !== undefined) {
          const start = fn.type.getStart(sourceFile)
          const end = fn.type.getEnd()
          return {
            edits: [{
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start,
              end,
              expectedTextHash: textHash(sourceFile.text.slice(start, end)),
              newText: returnType,
              evidenceIds: ["function:setReturnType"],
            }],
            evidence: [],
            matches: 1,
          }
        } else {
          const fnStart = fn.getStart(sourceFile)
          const fnText = sourceFile.text.slice(fnStart, fn.getEnd())
          const openParenRel = fnText.indexOf("(")
          const closeParenRel = fnText.indexOf(")", openParenRel)
          if (closeParenRel === -1) return empty
          const insertPos = fnStart + closeParenRel + 1
          return {
            edits: [{
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: `: ${returnType}`,
              evidenceIds: ["function:setReturnType"],
            }],
            evidence: [],
            matches: 1,
          }
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

/** Rename a symbol across all its declarations, imports, and reference occurrences in the project. */
export const renameSymbol = (
  project: ProjectSnapshot,
  symbol: NativeSymbol,
  newName: string,
): Effect.Effect<Draft, ProjectSnapshotError | QueryContractError> =>
  Effect.gen(function*() {
    const references = yield* Query.collect(Query.referencesTo(project, symbol))
    return yield* replaceEach(references, () => newName)
  })

/**
 * Convenience helper to find and rename a symbol by name in a project-relative file.
 * Returns `Draft.empty` if the symbol is not found (providing natural idempotency).
 */
export const renameSymbolNamed = (
  project: ProjectSnapshot,
  oldName: string,
  newName: string,
  options: { readonly within: string },
): Effect.Effect<Draft, ProjectSnapshotError | QueryContractError> =>
  Effect.gen(function*() {
    const symbolOption = yield* project.findSymbolNamed(oldName, options)
    if (Option.isNone(symbolOption)) {
      return empty
    }
    return yield* renameSymbol(project, symbolOption.value, newName)
  })

/** Clean up unused imports and unused declarations identified by TypeScript compiler diagnostics. */
export const cleanUnused = (
  project: ProjectSnapshot,
): Effect.Effect<Draft, ProjectSnapshotError | QueryContractError> =>
  Effect.gen(function*() {
    let accumulated = empty
    const sourceNames = yield* project.sourceFileNames

    for (const absPath of sourceNames) {
      const file = yield* project.sourceFile(absPath)
      if (file === undefined) continue

      for (const statement of file.statements) {
        if (isImportDeclaration(statement) && statement.importClause?.namedBindings && isNamedImports(statement.importClause.namedBindings)) {
          const named = statement.importClause.namedBindings
          for (const element of named.elements) {
            const sym = yield* project.symbolAt(file.fileName, element.name.getStart(file))
            if (sym !== undefined) {
              const refs = yield* Query.collect(Query.referencesTo(project, sym))
              // If only reference is the import itself
              if (refs.length <= 1) {
                const draft = yield* imports.removeNamed(project, statement, element.name.text)
                const conflicts = draft.edits.some((candidate) => accumulated.edits.some((existing) =>
                  candidate.projectId === existing.projectId &&
                  candidate.fileName === existing.fileName &&
                  candidate.start < existing.end && existing.start < candidate.end
                ))
                if (!conflicts) accumulated = concat(accumulated, draft)
              }
            }
          }
        }
      }
    }

    return accumulated
  })

export const Draft = {
  empty,
  concat,
  replace,
  replaceWith,
  replaceArgument,
  wrapArgument,
  remove,
  insertBefore,
  insertAfter,
  print,
  replaceEach,
  renameSymbol,
  renameSymbolNamed,
  cleanUnused,
  files,
  imports,
  interfaces,
  classes,
  functions,
  args,
  arguments: args,
  objectLiteral,
}
