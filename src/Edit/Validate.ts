import { Effect } from "effect"
import { EditConflict, InvalidEdit, type TextEdit } from "./Model.ts"

export const compareEdits = (left: TextEdit, right: TextEdit): number =>
  left.projectId.localeCompare(right.projectId) ||
  left.fileName.localeCompare(right.fileName) ||
  left.start - right.start ||
  left.end - right.end ||
  left.newText.localeCompare(right.newText)

export const editsConflict = (left: TextEdit, right: TextEdit): boolean => {
  if (left.projectId !== right.projectId || left.fileName !== right.fileName) return false
  const leftInsert = left.start === left.end
  const rightInsert = right.start === right.end
  if (leftInsert && rightInsert) return left.start === right.start
  if (leftInsert) return left.start >= right.start && left.start <= right.end
  if (rightInsert) return right.start >= left.start && right.start <= left.end
  return left.start < right.end && right.start < left.end
}

export const normalizeEdits = (
  edits: ReadonlyArray<TextEdit>,
): Effect.Effect<ReadonlyArray<TextEdit>, InvalidEdit | EditConflict> =>
  Effect.gen(function* () {
    const sorted = [...edits].sort(compareEdits)
    for (const edit of sorted) {
      if (
        !Number.isInteger(edit.start) ||
        !Number.isInteger(edit.end) ||
        edit.start < 0 ||
        edit.end < edit.start
      ) {
        return yield* new InvalidEdit({ edit, reason: "range" })
      }
    }
    for (let index = 1; index < sorted.length; index++) {
      const left = sorted[index - 1]!
      const right = sorted[index]!
      if (editsConflict(left, right)) return yield* new EditConflict({ left, right })
    }
    return sorted
  })
