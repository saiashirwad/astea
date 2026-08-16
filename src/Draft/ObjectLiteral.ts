import { Effect } from "effect"
import type { ObjectLiteralExpression } from "typescript/unstable/ast"
import { isIdentifier, isPropertyAssignment, isStringLiteral } from "typescript/unstable/ast/is"
import { textHash } from "../Edit/Hash.ts"
import { projectRelativePath } from "../Workspace/ProjectPath.ts"
import type { ProjectSnapshot, SnapshotExpired } from "../Workspace/index.ts"
import { empty, type Draft } from "./Model.ts"

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
