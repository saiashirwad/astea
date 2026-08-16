import { Effect } from "effect"
import type { CallExpression, Node } from "typescript/unstable/ast"
import { textHash } from "../Edit/Hash.ts"
import { projectRelativePath } from "../Workspace/ProjectPath.ts"
import type { ProjectSnapshot, SnapshotExpired } from "../Workspace/index.ts"
import { empty, replace, type Draft, type EditRangeOptions } from "./Model.ts"

/** Replace a specific argument of a call expression by 0-based index. */
export const replaceArgument = (
  project: ProjectSnapshot,
  call: CallExpression,
  index: number,
  newText: string,
  options?: EditRangeOptions,
): Effect.Effect<Draft, SnapshotExpired> => {
  const argument = call.arguments[index]
  return argument === undefined ? Effect.succeed(empty) : replace(project, argument, newText, options)
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
  return argument === undefined
    ? Effect.succeed(empty)
    : replace(project, argument, transform(argument.getText()), options)
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
