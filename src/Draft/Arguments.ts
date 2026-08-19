import { Effect } from "effect"
import type { CallExpression, Node } from "typescript/unstable/ast"
import { textHash } from "../Edit/Hash.ts"
import { projectRelativePath } from "../Workspace/ProjectPath.ts"
import type { ProjectSnapshot, SnapshotExpired } from "../Workspace/index.ts"
import { draftForEdit, empty, replace, type Draft, type EditRangeOptions } from "./Model.ts"

/** Replace a call argument by 0-based index, or return `Draft.empty` when it is absent. */
export const replaceArgument = (
  project: ProjectSnapshot,
  call: CallExpression,
  index: number,
  newText: string,
  options?: EditRangeOptions,
): Effect.Effect<Draft, SnapshotExpired> => {
  const argument = call.arguments[index]
  return argument === undefined
    ? Effect.succeed(empty)
    : replace(project, argument, newText, options)
}

/** Wrap a call argument by index, or return `Draft.empty` when it is absent. */
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

        return draftForEdit(
          {
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start,
            end,
            expectedTextHash: textHash(currentText),
            newText,
          },
          `argument:wrap:${index}`,
          { index },
        )
      }),
    ),

  /** Reorder by a full index permutation; invalid or identity arrays return `Draft.empty`. */
  reorder: (
    project: ProjectSnapshot,
    call: CallExpression,
    indices: ReadonlyArray<number>,
  ): Effect.Effect<Draft, SnapshotExpired> =>
    project.unsafeNative(() =>
      Effect.sync((): Draft => {
        const argumentCount = call.arguments.length
        if (
          argumentCount === 0 ||
          indices.length !== argumentCount ||
          new Set(indices).size !== argumentCount ||
          indices.some(
            (index) => !Number.isInteger(index) || index < 0 || index >= argumentCount,
          ) ||
          indices.every((index, position) => index === position)
        ) {
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

        return draftForEdit(
          {
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start,
            end,
            expectedTextHash: textHash(originalSlice),
            newText: orderedTexts.join(", "),
          },
          "argument:reorder",
          { indices: [...indices] },
        )
      }),
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
          return draftForEdit(
            {
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: text,
            },
            "argument:append",
          )
        } else {
          const lastArg = call.arguments[call.arguments.length - 1]!
          const insertPos = lastArg.getEnd()
          return draftForEdit(
            {
              projectId: project.project.id,
              fileName: projectRelativePath(project.root, sourceFile.fileName),
              start: insertPos,
              end: insertPos,
              expectedTextHash: textHash(""),
              newText: `, ${text}`,
            },
            "argument:append",
          )
        }
      }),
    ),
}
