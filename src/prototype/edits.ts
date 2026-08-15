/** PROTOTYPE — deterministic minimal text edits with explicit native fragment printing. */
import { createHash } from "node:crypto"
import { Data, Effect } from "effect"
import type { Node } from "typescript/unstable/ast"
import { nativeRequest, type NativeCompilerError } from "./native-compiler.ts"
import type { ProjectSnapshot } from "./workspace-snapshot.ts"

export interface TextEdit {
  readonly projectConfigFileName: string
  readonly fileName: string
  readonly start: number
  readonly end: number
  readonly newText: string
  readonly expectedTextHash: string
  readonly evidence: ReadonlyArray<string>
}

export class InvalidEdit extends Data.TaggedError("InvalidEdit")<{
  readonly edit: TextEdit
  readonly reason: "range" | "source-mismatch"
}> {}

export class EditConflict extends Data.TaggedError("EditConflict")<{
  readonly left: TextEdit
  readonly right: TextEdit
}> {}

export const textHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex")

export const makeTextEdit = (options: {
  readonly projectConfigFileName: string
  readonly fileName: string
  readonly sourceText: string
  readonly start: number
  readonly end: number
  readonly newText: string
  readonly evidence?: ReadonlyArray<string>
}): TextEdit => ({
  projectConfigFileName: options.projectConfigFileName,
  fileName: options.fileName,
  start: options.start,
  end: options.end,
  newText: options.newText,
  expectedTextHash: textHash(options.sourceText.slice(options.start, options.end)),
  evidence: options.evidence ?? [],
})

const compareEdits = (left: TextEdit, right: TextEdit): number =>
  left.projectConfigFileName.localeCompare(right.projectConfigFileName) ||
  left.fileName.localeCompare(right.fileName) ||
  left.start - right.start ||
  left.end - right.end ||
  left.newText.localeCompare(right.newText)

const conflicts = (left: TextEdit, right: TextEdit): boolean => {
  if (
    left.projectConfigFileName !== right.projectConfigFileName ||
    left.fileName !== right.fileName
  ) return false
  const leftInsert = left.start === left.end
  const rightInsert = right.start === right.end
  if (leftInsert && rightInsert) return left.start === right.start
  if (leftInsert) return left.start >= right.start && left.start <= right.end
  if (rightInsert) return right.start >= left.start && right.start <= left.end
  return left.start < right.end && right.start < left.end
}

export const normalizeEdits = (
  edits: ReadonlyArray<TextEdit>,
): Effect.Effect<ReadonlyArray<TextEdit>, InvalidEdit | EditConflict> => Effect.gen(function*() {
  const sorted = [...edits].sort(compareEdits)
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start) {
      return yield* new InvalidEdit({ edit, reason: "range" })
    }
  }
  for (let index = 1; index < sorted.length; index++) {
    const left = sorted[index - 1]!
    const right = sorted[index]!
    if (conflicts(left, right)) return yield* new EditConflict({ left, right })
  }
  return sorted
})

export const applyFileEdits = (
  sourceText: string,
  edits: ReadonlyArray<TextEdit>,
): Effect.Effect<string, InvalidEdit | EditConflict> => Effect.gen(function*() {
  const normalized = yield* normalizeEdits(edits)
  for (const edit of normalized) {
    if (edit.end > sourceText.length) return yield* new InvalidEdit({ edit, reason: "range" })
    if (textHash(sourceText.slice(edit.start, edit.end)) !== edit.expectedTextHash) {
      return yield* new InvalidEdit({ edit, reason: "source-mismatch" })
    }
  }
  let output = sourceText
  for (const edit of [...normalized].reverse()) {
    output = `${output.slice(0, edit.start)}${edit.newText}${output.slice(edit.end)}`
  }
  return output
})

export const printNativeFragment = (
  project: ProjectSnapshot,
  node: Node,
): Effect.Effect<string, NativeCompilerError | import("./workspace-snapshot.ts").SnapshotExpired> =>
  project.unsafeNative((nativeProject) =>
    nativeRequest("print native fragment", () => nativeProject.emitter.printNode(node)))
