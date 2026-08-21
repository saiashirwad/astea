import { Effect } from "effect"
import type { ImportDeclaration, SourceFile, Statement } from "typescript/unstable/ast"
import {
  isExpressionStatement,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isStringLiteral,
} from "typescript/unstable/ast/is"
import { textHash } from "../Edit/Hash.ts"
import {
  isProjectFile,
  type ProjectFile,
  type ProjectSnapshot,
  type ProjectSnapshotError,
  type SnapshotExpired,
} from "../Workspace/index.ts"
import { draftForEdit, empty, type Draft } from "./Draft.ts"

export interface AddNamedImportOptions {
  readonly module: string
  readonly name: string
  readonly alias?: string
}

export interface AddNamedImportFn {
  (file: ProjectFile, options: AddNamedImportOptions): Effect.Effect<Draft, ProjectSnapshotError>
  (
    project: ProjectSnapshot,
    fileName: string,
    options: AddNamedImportOptions,
  ): Effect.Effect<Draft, ProjectSnapshotError>
}

const isTopLevelDirective = (statement: Statement): boolean =>
  isExpressionStatement(statement) && isStringLiteral(statement.expression)

const importInsertionPosition = (sourceFile: SourceFile): number => {
  // getStart skips a shebang and leading trivia, preserving license headers
  // and comments while anchoring insertion to an actual statement token.
  const firstNonDirective = sourceFile.statements.find(
    (statement) => !isTopLevelDirective(statement),
  )
  return firstNonDirective?.getStart(sourceFile) ?? sourceFile.endOfFileToken.getStart(sourceFile)
}

export const imports = {
  /** Add a named import to a source file. */
  // SAFETY: Overloaded implementation handles ProjectFile and (ProjectSnapshot, fileName) argument signatures.
  addNamed: ((
    projectOrFile: ProjectSnapshot | ProjectFile,
    fileNameOrOptions: string | AddNamedImportOptions,
    maybeOptions?: AddNamedImportOptions,
  ): Effect.Effect<Draft, ProjectSnapshotError> => {
    const isFile = isProjectFile(projectOrFile)
    const project = isFile ? projectOrFile.project : projectOrFile
    // SAFETY: When projectOrFile is not a ProjectFile, fileNameOrOptions is guaranteed to be the string path.
    const fileName = isFile ? projectOrFile.path : (fileNameOrOptions as string)
    // SAFETY: When projectOrFile is a ProjectFile, fileNameOrOptions is the options object; otherwise options is in maybeOptions.
    const options = isFile ? (fileNameOrOptions as AddNamedImportOptions) : maybeOptions!

    return Effect.gen(function* () {
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
                  if (
                    clause.phaseModifier !== undefined ||
                    named.elements.some((element) => element.isTypeOnly)
                  ) {
                    return empty
                  }
                  for (const element of named.elements) {
                    if (element.name.text === (options.alias ?? options.name)) {
                      return empty
                    }
                  }

                  if (named.elements.length > 0) {
                    const last = named.elements[named.elements.length - 1]!
                    const insertPos = last.getEnd()
                    return draftForEdit(
                      {
                        projectId: project.project.id,
                        fileName: project.relativeFileName(source.fileName),
                        start: insertPos,
                        end: insertPos,
                        expectedTextHash: textHash(""),
                        newText: `, ${importName}`,
                      },
                      `import:addNamed:${options.module}:${options.name}`,
                      { module: options.module, name: options.name },
                    )
                  }
                }
              }
            }
          }

          const insertPos = importInsertionPosition(source)
          const importText = `import { ${importName} } from "${options.module}";\n`

          return draftForEdit(
            {
              projectId: project.project.id,
              fileName: project.relativeFileName(source.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: importText,
            },
            `import:addNamed:${options.module}:${options.name}`,
            { module: options.module, name: options.name },
          )
        }),
      )
    })
    // SAFETY: Overloaded implementation handles ProjectFile and (ProjectSnapshot, fileName) argument signatures.
  }) as AddNamedImportFn,

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
        const targetIndex = elements.findIndex(
          (el) => el.name.text === name || el.propertyName?.text === name,
        )

        if (targetIndex === -1) return empty

        const sourceFile = declaration.getSourceFile()

        if (elements.length === 1) {
          const start = clause.name?.getEnd() ?? declaration.getFullStart()
          const end = clause.name === undefined ? declaration.getEnd() : named.getEnd()
          return draftForEdit(
            {
              projectId: project.project.id,
              fileName: project.relativeFileName(sourceFile.fileName),
              start,
              end,
              expectedTextHash: textHash(sourceFile.text.slice(start, end)),
              newText: "",
            },
            `import:removeNamed:${name}`,
            { name },
          )
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

        return draftForEdit(
          {
            projectId: project.project.id,
            fileName: project.relativeFileName(sourceFile.fileName),
            start,
            end,
            expectedTextHash: textHash(sourceFile.text.slice(start, end)),
            newText: "",
          },
          `import:removeNamed:${name}`,
          { name },
        )
      }),
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
        if (specifier.text === newModule) return empty

        const sourceFile = declaration.getSourceFile()
        const quote = specifier.getText(sourceFile)[0] ?? '"'
        const newSpecifierText = `${quote}${newModule}${quote}`
        const start = specifier.getStart(sourceFile)
        const end = specifier.getEnd()

        return draftForEdit(
          {
            projectId: project.project.id,
            fileName: project.relativeFileName(sourceFile.fileName),
            start,
            end,
            expectedTextHash: textHash(sourceFile.text.slice(start, end)),
            newText: newSpecifierText,
          },
          `import:update-source:${newModule}`,
          { module: newModule },
        )
      }),
    ),

  /**
   * Organize simple default/named value imports. Unsupported forms or import
   * trivia are a no-op so type-only, namespace, and side-effect imports are
   * never reprinted with changed semantics or style.
   */
  organize: (
    project: ProjectSnapshot,
    fileName: string,
  ): Effect.Effect<Draft, ProjectSnapshotError> =>
    Effect.gen(function* () {
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
          const firstIndex = source.statements.indexOf(firstDecl)
          const lastIndex = source.statements.indexOf(lastDecl)
          const importBlock = source.statements.slice(firstIndex, lastIndex + 1)
          const lineEnd = source.text.indexOf("\n", end)
          const trailingLine = source.text.slice(end, lineEnd === -1 ? source.text.length : lineEnd)
          const hasComment = (text: string): boolean => /\/[/*]/.test(text)
          const currentImports = source.text.slice(start, end)

          if (
            importBlock.length !== importDecls.length ||
            importBlock.some((statement) => !isImportDeclaration(statement)) ||
            hasComment(source.text.slice(firstDecl.getFullStart(), start)) ||
            hasComment(currentImports) ||
            hasComment(trailingLine) ||
            currentImports.includes("\r")
          ) {
            return empty
          }

          const byModule = new Map<
            string,
            { quote: string; defaultImport?: string; namedImports: Set<string> }
          >()
          for (const decl of importDecls) {
            const specifier = decl.moduleSpecifier
            const clause = decl.importClause
            if (
              !isStringLiteral(specifier) ||
              clause === undefined ||
              clause.phaseModifier !== undefined
            ) {
              return empty
            }
            if (
              (clause.name !== undefined && !isIdentifier(clause.name)) ||
              (clause.namedBindings !== undefined && !isNamedImports(clause.namedBindings)) ||
              (clause.name === undefined && clause.namedBindings === undefined)
            ) {
              return empty
            }
            const named =
              clause.namedBindings !== undefined && isNamedImports(clause.namedBindings)
                ? clause.namedBindings
                : undefined
            if (
              (clause.name === undefined && (named === undefined || named.elements.length === 0)) ||
              named?.elements.some(
                (element) =>
                  element.isTypeOnly ||
                  !isIdentifier(element.name) ||
                  (element.propertyName !== undefined && !isIdentifier(element.propertyName)),
              ) === true
            ) {
              return empty
            }

            const specifierText = specifier.getText(source)
            const quote = specifierText[0]
            const suffix = source.text.slice(specifier.getEnd(), decl.getEnd())
            if (
              (quote !== '"' && quote !== "'") ||
              specifierText !== `${quote}${specifier.text}${quote}` ||
              !/^\s*;$/.test(suffix)
            ) {
              return empty
            }

            const mod = specifier.text
            let existing = byModule.get(mod)
            if (existing === undefined) {
              existing = { quote, namedImports: new Set() }
              byModule.set(mod, existing)
            } else if (
              existing.quote !== quote ||
              (existing.defaultImport !== undefined &&
                clause.name !== undefined &&
                existing.defaultImport !== clause.name.text)
            ) {
              return empty
            }
            if (clause.name) existing.defaultImport = clause.name.text
            if (named !== undefined) {
              for (const element of named.elements) {
                const specText = element.propertyName
                  ? `${element.propertyName.text} as ${element.name.text}`
                  : element.name.text
                existing.namedImports.add(specText)
              }
            }
          }

          const isBuiltin = (m: string) =>
            m.startsWith("node:") ||
            ["fs", "path", "crypto", "os", "util", "events", "url"].includes(m)
          const isRelative = (m: string) =>
            m.startsWith(".") || m.startsWith("/") || m.startsWith("@/")

          const modules = [...byModule.keys()]
          const builtins = modules.filter(isBuiltin).sort()
          const external = modules.filter((m) => !isBuiltin(m) && !isRelative(m)).sort()
          const internal = modules.filter(isRelative).sort()

          const renderGroup = (mods: Array<string>) =>
            mods
              .map((mod) => {
                const entry = byModule.get(mod)!
                const parts: Array<string> = []
                if (entry.defaultImport) parts.push(entry.defaultImport)
                if (entry.namedImports.size > 0) {
                  const sortedNamed = [...entry.namedImports].sort()
                  parts.push(`{ ${sortedNamed.join(", ")} }`)
                }
                return `import ${parts.join(", ")} from ${entry.quote}${mod}${entry.quote};`
              })
              .join("\n")

          const groups = [
            renderGroup(builtins),
            renderGroup(external),
            renderGroup(internal),
          ].filter(Boolean)
          const formattedImports = groups.join("\n\n")
          if (formattedImports === currentImports) return empty

          return draftForEdit(
            {
              projectId: project.project.id,
              fileName: project.relativeFileName(source.fileName),
              start,
              end,
              expectedTextHash: textHash(currentImports),
              newText: formattedImports,
            },
            "import:organize",
            { imports: importDecls.length },
          )
        }),
      )
    }),
}
