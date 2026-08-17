import { Effect } from "effect"
import { InvalidEdit, type EditConflict, type TextEdit } from "./Model.ts"
import { textHash } from "./Hash.ts"
import { normalizeEdits } from "./Validate.ts"

export const applyFileEdits = (
  sourceText: string,
  edits: ReadonlyArray<TextEdit>,
): Effect.Effect<string, InvalidEdit | EditConflict> =>
  Effect.gen(function* () {
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
