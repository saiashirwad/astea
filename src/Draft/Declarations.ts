import { Effect } from "effect"
import {
  createScanner,
  SyntaxKind,
  type ArrowFunction,
  type ClassDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type InterfaceDeclaration,
  type MethodDeclaration,
} from "typescript/unstable/ast"
import {
  isIdentifier,
  isPropertySignatureDeclaration,
  isStringLiteral,
} from "typescript/unstable/ast/is"
import { textHash } from "../Edit/Hash.ts"
import { projectRelativePath } from "../Workspace/ProjectPath.ts"
import type { ProjectSnapshot, SnapshotExpired } from "../Workspace/index.ts"
import { draftForEdit, empty, type Draft } from "./Model.ts"

// // =============================================================================

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

        return draftForEdit(
          {
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start: insertPos,
            end: insertPos,
            expectedTextHash: textHash(""),
            newText: propertyText,
          },
          `interface:addProperty:${options.name}`,
          { name: options.name },
        )
      }),
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
            const name =
              isIdentifier(member.name) || isStringLiteral(member.name) ? member.name.text : ""
            if (name === propertyName) {
              const start = member.getFullStart()
              const end = member.getEnd()
              const nextChar = sourceFile.text[end]
              const actualEnd = nextChar === ";" || nextChar === "," ? end + 1 : end
              return draftForEdit(
                {
                  projectId: project.project.id,
                  fileName: projectRelativePath(project.root, sourceFile.fileName),
                  start,
                  end: actualEnd,
                  expectedTextHash: textHash(sourceFile.text.slice(start, actualEnd)),
                  newText: "",
                },
                `interface:removeProperty:${propertyName}`,
                { name: propertyName },
              )
            }
          }
        }
        return empty
      }),
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

        return draftForEdit(
          {
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start: insertPos,
            end: insertPos,
            expectedTextHash: textHash(""),
            newText: propText,
          },
          `class:addProperty:${options.name}`,
          { name: options.name },
        )
      }),
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

        return draftForEdit(
          {
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start: insertPos,
            end: insertPos,
            expectedTextHash: textHash(""),
            newText: methodText,
          },
          `class:addMethod:${options.name}`,
          { name: options.name },
        )
      }),
    ),
}

export interface FunctionParamOptions {
  readonly name: string
  readonly type?: string
  readonly default?: string
  readonly optional?: boolean
}

const emptyParameterListCloseEnd = (
  fn: FunctionDeclaration | FunctionExpression | ArrowFunction | MethodDeclaration,
  sourceFile: ReturnType<typeof fn.getSourceFile>,
): number | undefined => {
  const limit = fn.body?.getStart(sourceFile) ?? fn.getEnd()
  const scanner = createScanner(
    true,
    sourceFile.languageVariant,
    sourceFile.text,
    fn.parameters.pos,
    limit - fn.parameters.pos,
  )
  let depth = 0
  while (true) {
    const token = scanner.scan()
    if (token === SyntaxKind.EndOfFile) return undefined
    if (token === SyntaxKind.CloseParenToken && depth === 0) return scanner.getTokenEnd()
    if (token === SyntaxKind.OpenParenToken) depth += 1
    if (token === SyntaxKind.CloseParenToken) {
      depth -= 1
      if (depth === 0) return scanner.getTokenEnd()
    }
  }
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
          const closeEnd = emptyParameterListCloseEnd(fn, sourceFile)
          if (closeEnd === undefined) return empty
          const insertPos = closeEnd - 1
          return draftForEdit(
            {
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: paramStr,
            },
            `function:addParam:${options.name}`,
            { name: options.name },
          )
        } else {
          const lastParam = params[params.length - 1]!
          const insertPos = lastParam.getEnd()
          return draftForEdit(
            {
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: `, ${paramStr}`,
            },
            `function:addParam:${options.name}`,
            { name: options.name },
          )
        }
      }),
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
          if (sourceFile.text.slice(start, end) === returnType) return empty
          return draftForEdit(
            {
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start,
              end,
              expectedTextHash: textHash(sourceFile.text.slice(start, end)),
              newText: returnType,
            },
            "function:setReturnType",
            { returnType },
          )
        } else {
          const insertPos = emptyParameterListCloseEnd(fn, sourceFile)
          if (insertPos === undefined) return empty
          return draftForEdit(
            {
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: `: ${returnType}`,
            },
            "function:setReturnType",
            { returnType },
          )
        }
      }),
    ),
}
