import { Effect } from "effect"
import type { ArrowFunction, ClassDeclaration, FunctionDeclaration, FunctionExpression, InterfaceDeclaration, MethodDeclaration } from "typescript/unstable/ast"
import { isIdentifier, isPropertySignatureDeclaration, isStringLiteral } from "typescript/unstable/ast/is"
import { textHash } from "../Edit/Hash.ts"
import { projectRelativePath } from "../Workspace/ProjectPath.ts"
import type { ProjectSnapshot, SnapshotExpired } from "../Workspace/index.ts"
import { empty, type Draft } from "./Model.ts"

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
