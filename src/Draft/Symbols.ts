import { Effect, Option } from "effect"
import type {
  ExportDeclaration,
  Identifier,
  ImportDeclaration,
  Node,
} from "typescript/unstable/ast"
import {
  isExportDeclaration,
  isExportSpecifier,
  isImportDeclaration,
  isImportSpecifier,
  isStringLiteral,
} from "typescript/unstable/ast/is"
import type { Symbol as NativeSymbol } from "typescript/unstable/async"
import * as Query from "../Query/index.ts"
import type { QueryContractError } from "../Query/index.ts"
import {
  isProjectFile,
  type ProjectFile,
  type ProjectSnapshot,
  type ProjectSnapshotError,
} from "../Workspace/index.ts"
import type { DraftEvidenceConflict } from "../Evidence/index.ts"
import { empty, replaceEach, type Draft, type Replacement } from "./Draft.ts"
import { resolveRelativeSpecifier, stripModuleExtension } from "./internal/ModuleSpecifiers.ts"

/**
 * How one reference participates in a rename:
 *
 * - `rename`: rewrite the identifier text to the new name.
 * - `rewriteSpecifier`: rewrite a whole import/export specifier so the
 *   source-facing name follows the rename while the local binding keeps its
 *   chosen name (`{ target }` becomes `{ newName as target }`).
 * - `preserve`: a chosen name — an alias (`as renamed`), or any specifier
 *   whose immediate module keeps its own export names. Usages bound through
 *   a preserved name are left untouched.
 */
type ReferenceAction =
  | { readonly kind: "rename" }
  | {
      readonly kind: "rewriteSpecifier"
      readonly specifier: Node
      readonly newText: string
      readonly preservedName: string
    }
  | { readonly kind: "preserve"; readonly preservedName: string }

interface RenameContext {
  readonly newName: string
  /** Resolve a project-relative file name to its absolute form. */
  readonly resolveAbsolute: (fileName: string) => string
  /**
   * Lowercased absolute declaration path without extension. Computed straight
   * from the native symbol because native paths can differ from workspace
   * paths in letter case on case-insensitive filesystems.
   */
  readonly declarationKey?: string | undefined
}

/**
 * Resolve the module a specifier imports or re-exports from, as a normalized
 * project-relative path. Local export specifiers have no module specifier and
 * count as referencing their own file.
 */
const specifierModuleFile = (specifierParent: Node, importerFile: string): string | undefined => {
  if (isImportDeclaration(specifierParent)) {
    const specifier = specifierParent.moduleSpecifier
    return isStringLiteral(specifier)
      ? resolveRelativeSpecifier(importerFile, specifier.text)
      : undefined
  }
  if (isExportDeclaration(specifierParent)) {
    const specifier = specifierParent.moduleSpecifier
    return specifier === undefined || !isStringLiteral(specifier)
      ? importerFile
      : resolveRelativeSpecifier(importerFile, specifier.text)
  }
  return undefined
}

/**
 * Find the import or export declaration owning a specifier. Specifiers nest
 * through named containers (`NamedImports`/`NamedExports`), so the module
 * declaration may be more than one level up.
 */
const owningModuleDeclaration = (node: Node): ImportDeclaration | ExportDeclaration | undefined => {
  let current: Node | undefined = node.parent
  while (current !== undefined) {
    if (isImportDeclaration(current) || isExportDeclaration(current)) return current
    current = current.parent
  }
  return undefined
}

/**
 * A specifier's source-facing side follows the rename only when its immediate
 * module is the one being renamed. Modules upstream in a re-export chain keep
 * their export names (this algorithm preserves them), so specifiers pointing
 * at those modules stay exactly as authored.
 */
const referencesDeclaringModule = (
  specifierParent: Node,
  importerFile: string,
  context: RenameContext,
): boolean => {
  const moduleFile = specifierModuleFile(specifierParent, importerFile)
  if (moduleFile === undefined) return false
  const declarationKey = context.declarationKey
  if (declarationKey === undefined) return false
  const moduleAbsolute = context.resolveAbsolute(moduleFile)
  return stripModuleExtension(moduleAbsolute).toLowerCase() === declarationKey
}

const classifyReference = (
  selection: Query.Selection<Identifier>,
  context: RenameContext,
): ReferenceAction => {
  const identifier = selection.value
  const parent = identifier.parent

  if (isImportSpecifier(parent) || isExportSpecifier(parent)) {
    // The owning declaration carries the module specifier.
    const moduleDeclaration = owningModuleDeclaration(parent)
    const declaring =
      moduleDeclaration !== undefined &&
      referencesDeclaringModule(moduleDeclaration, selection.fileName, context)

    if (parent.propertyName !== undefined) {
      // `{ target as renamed }`: the property names the source export; the
      // alias is the author's chosen name.
      if (identifier !== parent.propertyName) {
        return { kind: "preserve", preservedName: identifier.text }
      }
      return declaring ? { kind: "rename" } : { kind: "preserve", preservedName: identifier.text }
    }

    // Plain binding `{ target }`: it names both sides, so when the immediate
    // module's export is renamed, alias to keep the local binding stable.
    if (declaring) {
      return {
        kind: "rewriteSpecifier",
        specifier: parent,
        newText: `${context.newName} as ${identifier.text}`,
        preservedName: identifier.text,
      }
    }
    return { kind: "preserve", preservedName: identifier.text }
  }

  return { kind: "rename" }
}

/**
 * Rename a symbol across its declaration and every reference that would
 * otherwise break. Chosen names survive: aliases are never rewritten, and
 * re-export chains keep their public names, so downstream importers of those
 * names need no edits at all.
 */
export const renameSymbol = (
  project: ProjectSnapshot,
  symbol: NativeSymbol,
  newName: string,
): Effect.Effect<Draft, ProjectSnapshotError | QueryContractError | DraftEvidenceConflict> =>
  Effect.gen(function* () {
    const declarationPath = symbol.valueDeclaration?.path ?? symbol.declarations?.[0]?.path
    const references = yield* Query.collect(Query.referencesTo(project, symbol))
    const context: RenameContext = {
      newName,
      resolveAbsolute: (fileName) => project.resolveFileName(fileName),
      declarationKey:
        declarationPath === undefined
          ? undefined
          : stripModuleExtension(String(declarationPath)).toLowerCase(),
    }
    const classified = references.map((selection) => ({
      selection,
      action: classifyReference(selection, context),
    }))

    // Names this rename preserves: usages bound through them stay unchanged.
    const preservedByFile = new Map<string, Set<string>>()
    for (const { selection, action } of classified) {
      const preservedName =
        action.kind === "preserve" || action.kind === "rewriteSpecifier"
          ? action.preservedName
          : undefined
      if (preservedName === undefined) continue
      const preserved = preservedByFile.get(selection.fileName) ?? new Set<string>()
      preserved.add(preservedName)
      preservedByFile.set(selection.fileName, preserved)
    }

    const planned = classified.filter(({ selection, action }) => {
      if (action.kind === "preserve") return false
      if (action.kind === "rename") {
        return !preservedByFile.get(selection.fileName)?.has(selection.value.text)
      }
      return true
    })

    const actionBySelection = new Map(planned.map((plan) => [plan.selection, plan.action]))
    return yield* replaceEach(
      planned.map((plan) => plan.selection),
      (selection): Replacement => {
        const action = actionBySelection.get(selection)!
        if (action.kind === "rewriteSpecifier") {
          return { node: action.specifier, text: action.newText }
        }
        return newName
      },
    )
  })

export interface RenameSymbolNamedFn {
  (
    file: ProjectFile,
    oldName: string,
    newName: string,
  ): Effect.Effect<Draft, ProjectSnapshotError | QueryContractError | DraftEvidenceConflict>
  (
    project: ProjectSnapshot,
    oldName: string,
    newName: string,
    options: { readonly lookupIn: string },
  ): Effect.Effect<Draft, ProjectSnapshotError | QueryContractError | DraftEvidenceConflict>
}

/**
 * Find a symbol by name and rename it. The file or `lookupIn` path only
 * locates which symbol the name refers to; the rename itself always applies
 * across the whole project, because partially renaming a shared symbol would
 * break its importers.
 *
 * Returns `Draft.empty` if the symbol is not found (natural idempotency).
 */
export const renameSymbolNamed: RenameSymbolNamedFn = (
  projectOrFile: ProjectSnapshot | ProjectFile,
  oldName: string,
  newName: string,
  maybeOptions?: { readonly lookupIn: string },
): Effect.Effect<Draft, ProjectSnapshotError | QueryContractError | DraftEvidenceConflict> =>
  Effect.gen(function* () {
    const isFile = isProjectFile(projectOrFile)
    const project = isFile ? projectOrFile.project : projectOrFile
    const lookupIn = isFile ? projectOrFile.path : maybeOptions!.lookupIn
    const symbolOption = yield* project.findSymbolNamed(oldName, { within: lookupIn })
    if (Option.isNone(symbolOption)) {
      return empty
    }
    return yield* renameSymbol(project, symbolOption.value, newName)
  })
