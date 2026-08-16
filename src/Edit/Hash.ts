import { createHash } from "node:crypto"
import type { TextEdit } from "./Model.ts"

export const textHash = (text: string): string => createHash("sha256").update(text).digest("hex")

export const makeTextEdit = (options: {
  readonly projectId: string
  readonly fileName: string
  readonly sourceText: string
  readonly start: number
  readonly end: number
  readonly newText: string
  readonly evidenceIds?: ReadonlyArray<string>
}): TextEdit => ({
  projectId: options.projectId,
  fileName: options.fileName,
  start: options.start,
  end: options.end,
  newText: options.newText,
  expectedTextHash: textHash(options.sourceText.slice(options.start, options.end)),
  evidenceIds: options.evidenceIds ?? [],
})
