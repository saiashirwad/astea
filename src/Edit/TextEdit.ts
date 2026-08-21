import { Data } from "effect"

/** The canonical durable, guarded, half-open source range replacement. */
export interface TextEdit {
  readonly projectId: string
  readonly fileName: string
  readonly start: number
  readonly end: number
  readonly expectedTextHash: string
  readonly newText: string
  readonly evidenceIds: ReadonlyArray<string>
}

export class InvalidEdit extends Data.TaggedError("InvalidEdit")<{
  readonly edit: TextEdit
  readonly reason: "range" | "source-mismatch"
}> {}

export class EditConflict extends Data.TaggedError("EditConflict")<{
  readonly left: TextEdit
  readonly right: TextEdit
}> {}
