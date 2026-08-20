import { describe, expect, it } from "vitest"
import { DraftEvidenceConflict, finalizeDraftEvidence, mergeEvidence } from "./Finalize.ts"

describe("draft evidence finalization", () => {
  it("merges records and completes every referenced ID in stable order", () => {
    const draft = finalizeDraftEvidence(
      {
        edits: [{ evidenceIds: ["declared", "edit"] }],
        fileOperations: [{ evidenceIds: ["operation", "edit"] }],
        evidence: [{ id: "declared", kind: "selection", facts: { selected: true } }],
        matches: 1,
      },
      { facts: { source: "test" } },
    )

    expect(draft.evidence).toEqual([
      { id: "declared", kind: "selection", facts: { selected: true } },
      { id: "edit", kind: "draft-operation", facts: { source: "test" } },
      { id: "operation", kind: "draft-operation", facts: { source: "test" } },
    ])
    expect(draft.matches).toBe(1)
  })

  it("deduplicates records with canonically equal facts", () => {
    const evidence = mergeEvidence([
      { id: "same", kind: "selection", facts: { first: true, second: 2 } },
      { id: "same", kind: "selection", facts: { second: 2, first: true } },
    ])

    expect(evidence).toHaveLength(1)
  })

  it("rejects one ID with different evidence", () => {
    expect(() =>
      mergeEvidence([
        { id: "same", kind: "selection", facts: { value: 1 } },
        { id: "same", kind: "selection", facts: { value: 2 } },
      ]),
    ).toThrow(DraftEvidenceConflict)
  })
})
