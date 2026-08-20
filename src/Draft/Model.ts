/**
 * Draft domain — immutable proposed transformations.
 *
 * A Draft is an immutable value: the edits a recipe proposes plus the
 * evidence that explains them and the primary-run match measurement. Authors
 * never compute ranges, hashes, file identity, or evidence IDs — every edit
 * is declared against a native node or a Selection, and the builder derives
 * the durable guard data from the snapshot. Finalization (ordering, conflict
 * rejection, plan identity) belongs to the engine in `Recipe.run`.
 */
import { Data, Effect, Predicate } from "effect"
import {
  asJson,
  canonicalJson,
  type EvidenceRecord,
  type PlannedFileOperation,
} from "../Plan/index.ts"
import type { Node } from "typescript/unstable/ast"
import { textHash } from "../Edit/Hash.ts"
import type { TextEdit } from "../Edit/Model.ts"
import { nativeRequest, type NativeCompilerError } from "../Compiler/Service.ts"
import { projectRelativePath } from "../Node/ProjectPath.ts"
import type { Selection } from "../Query/index.ts"
import type { ProjectSnapshot, SnapshotExpired } from "../Workspace/index.ts"

/** An edit in pre-finalization form; identical in shape to its durable counterpart. */
export type ProposedEdit = TextEdit

export interface Draft {
  readonly edits: ReadonlyArray<ProposedEdit>
  readonly fileOperations?: ReadonlyArray<PlannedFileOperation>
  readonly evidence: ReadonlyArray<EvidenceRecord>
  /** Number of matched source targets represented by this draft. */
  readonly matches: number
}

export const empty: Draft = { edits: [], fileOperations: [], evidence: [], matches: 0 }

export class DraftEvidenceConflict extends Data.TaggedError("DraftEvidenceConflict")<{
  readonly id: string
}> {}

const evidenceIdentity = (record: EvidenceRecord): string =>
  `${record.kind}\0${canonicalJson(asJson(record.facts))}`

/** Keep identical records; reject the same ID with different kind or facts. */
export const mergeEvidence = (
  records: ReadonlyArray<EvidenceRecord>,
): ReadonlyArray<EvidenceRecord> => {
  const evidence = new Map<string, EvidenceRecord>()
  for (const record of records) {
    const existing = evidence.get(record.id)
    if (existing === undefined) {
      evidence.set(record.id, record)
      continue
    }
    if (evidenceIdentity(existing) !== evidenceIdentity(record)) {
      throw new DraftEvidenceConflict({ id: record.id })
    }
  }
  return [...evidence.values()]
}

/** Effect form of `mergeEvidence` so Recipe composition can fail typed, not as a defect. */
export const mergeEvidenceEffect = (
  records: ReadonlyArray<EvidenceRecord>,
): Effect.Effect<ReadonlyArray<EvidenceRecord>, DraftEvidenceConflict> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(mergeEvidence(records))
    } catch (cause) {
      return cause instanceof DraftEvidenceConflict ? Effect.fail(cause) : Effect.die(cause)
    }
  })

/** Effect form of `concat` for Recipe.pipe / Recipe.all. */
export const concatEffect = (
  ...drafts: ReadonlyArray<Draft>
): Effect.Effect<Draft, DraftEvidenceConflict> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(concat(...drafts))
    } catch (cause) {
      return cause instanceof DraftEvidenceConflict ? Effect.fail(cause) : Effect.die(cause)
    }
  })

/** Combine drafts built from disjoint selections. Conflicting overlaps are rejected at finalization. */
export const concat = (...drafts: ReadonlyArray<Draft>): Draft => {
  const edits = drafts.flatMap((draft) => [...draft.edits])
  const fileOperations = drafts.flatMap((draft) =>
    draft.fileOperations ? [...draft.fileOperations] : [],
  )
  const evidence = new Map(
    mergeEvidence(drafts.flatMap((draft) => draft.evidence)).map((record) => [record.id, record]),
  )
  const referencedIds = [
    ...edits.flatMap((edit) => edit.evidenceIds),
    ...fileOperations.flatMap((operation) => operation.evidenceIds ?? []),
  ]
  for (const id of referencedIds) {
    if (!evidence.has(id)) {
      // Synthesize rather than reject: Recipe.run already backfills the same
      // kind so a helper that only recorded evidenceIds stays a valid plan.
      evidence.set(id, {
        id,
        kind: "draft-operation",
        facts: { source: "concat" },
      })
    }
  }
  return {
    edits,
    fileOperations,
    evidence: [...evidence.values()],
    matches: drafts.reduce((total, draft) => total + draft.matches, 0),
  }
}

type DraftEdit = Omit<ProposedEdit, "evidenceIds">

/** Build one syntax edit with deterministic, self-contained operation evidence. */
export const draftForEdit = (
  edit: DraftEdit,
  operation: string,
  facts: EvidenceRecord["facts"] = {},
): Draft => {
  const evidenceId = `${operation}:${edit.projectId}:${edit.fileName}:${edit.start}-${edit.end}`
  return {
    edits: [{ ...edit, evidenceIds: [evidenceId] }],
    evidence: [
      {
        id: evidenceId,
        kind: "draft-operation",
        facts: {
          ...facts,
          operation,
          projectId: edit.projectId,
          fileName: edit.fileName,
          start: edit.start,
          end: edit.end,
        },
      },
    ],
    matches: 1,
  }
}

export interface EditRangeOptions {
  readonly includeLeadingTrivia?: boolean
}

const editForNode = (
  project: ProjectSnapshot,
  node: Node,
  newText: string,
  options?: EditRangeOptions & { readonly evidenceIds?: ReadonlyArray<string> },
): Effect.Effect<ProposedEdit, SnapshotExpired> =>
  project.unsafeNative(() =>
    Effect.sync(() => {
      const sourceFile = node.getSourceFile()
      const start =
        options?.includeLeadingTrivia === true ? node.getFullStart() : node.getStart(sourceFile)
      const end = node.getEnd()
      return {
        projectId: project.project.id,
        fileName: projectRelativePath(project.root, sourceFile.fileName),
        start,
        end,
        expectedTextHash: textHash(sourceFile.text.slice(start, end)),
        newText,
        evidenceIds: options?.evidenceIds ?? [],
      }
    }),
  )

/** Replace a node's source range with new text. */
export const replace = (
  project: ProjectSnapshot,
  node: Node,
  newText: string,
  options?: EditRangeOptions,
): Effect.Effect<Draft, SnapshotExpired> =>
  editForNode(project, node, newText, options).pipe(
    Effect.map(({ evidenceIds: _, ...edit }) => draftForEdit(edit, "node:replace")),
  )

/** Remove a node's source range entirely. */
export const remove = (
  project: ProjectSnapshot,
  node: Node,
  options?: EditRangeOptions,
): Effect.Effect<Draft, SnapshotExpired> => replace(project, node, "", options)

/** Insert text immediately before a node's first token. */
export const insertBefore = (
  project: ProjectSnapshot,
  node: Node,
  text: string,
): Effect.Effect<Draft, SnapshotExpired> => insertAtNode(project, node, text, "before")

/** Insert text immediately after a node's end. */
export const insertAfter = (
  project: ProjectSnapshot,
  node: Node,
  text: string,
): Effect.Effect<Draft, SnapshotExpired> => insertAtNode(project, node, text, "after")

const insertAtNode = (
  project: ProjectSnapshot,
  node: Node,
  text: string,
  side: "before" | "after",
): Effect.Effect<Draft, SnapshotExpired> =>
  project.unsafeNative(() =>
    Effect.sync(() => {
      const sourceFile = node.getSourceFile()
      const position = side === "before" ? node.getStart(sourceFile) : node.getEnd()
      return draftForEdit(
        {
          projectId: project.project.id,
          fileName: projectRelativePath(project.root, sourceFile.fileName),
          start: position,
          end: position,
          expectedTextHash: textHash(""),
          newText: text,
        },
        `node:insert-${side}`,
      )
    }),
  )

/** Print a synthesized or updated native node to source text via the native emitter. */
export const print = (
  project: ProjectSnapshot,
  node: Node,
): Effect.Effect<string, NativeCompilerError | SnapshotExpired> =>
  project.unsafeNative((nativeProject) =>
    nativeRequest("print native fragment", () => nativeProject.emitter.printNode(node)),
  )

/** Replace a node with a printed native fragment (e.g. built with the native factory API). */
export const replaceWith = (
  project: ProjectSnapshot,
  node: Node,
  fragment: Node,
  options?: EditRangeOptions,
): Effect.Effect<Draft, NativeCompilerError | SnapshotExpired> =>
  print(project, fragment).pipe(Effect.flatMap((text) => replace(project, node, text, options)))

/** The replacement a selection maps to: text only (replace the selected node) or an explicit target node. */
export type Replacement = string | { readonly node: Node; readonly text: string }

const isTextReplacement = (val: Replacement): val is string => Predicate.isString(val)

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Type guard boundary for candidate draft values.
export const isDraft = (value: unknown): value is Draft =>
  Predicate.isObject(value) && "edits" in value && "evidence" in value && "matches" in value

/**
 * Propose one replacement per selection. Each edit inherits its selection's
 * Query Evidence automatically; the draft records the selection count as the
 * primary-run match measurement.
 */
export const replaceEach = <A extends Node, E = never, R = never>(
  selections: ReadonlyArray<Selection<A>>,
  replacement: (
    selection: Selection<A>,
  ) => Replacement | Draft | Effect.Effect<Replacement | Draft, E, R>,
): Effect.Effect<Draft, E | SnapshotExpired | DraftEvidenceConflict, R> =>
  Effect.forEach(selections, (selection) => {
    const raw = replacement(selection)
    const effect: Effect.Effect<Replacement | Draft, E, R> = Effect.isEffect(raw)
      ? raw
      : Effect.succeed(raw)
    return effect.pipe(
      Effect.flatMap(
        (proposed): Effect.Effect<Draft, E | SnapshotExpired | DraftEvidenceConflict, R> => {
          if (isDraft(proposed)) {
            const evidenceId = `selection:${selection.project.project.id}:${selection.fileName}:${selection.start}-${selection.end}`
            // A returned Draft.empty is still one selected occurrence. Match
            // policies and scan audits count the selection, not whether an edit
            // was produced.
            if (
              proposed.edits.length === 0 &&
              (proposed.fileOperations?.length ?? 0) === 0 &&
              proposed.evidence.length === 0 &&
              proposed.matches === 0
            ) {
              return Effect.succeed({
                edits: [],
                fileOperations: [],
                evidence: [selectionEvidence(selection, evidenceId)],
                matches: 1,
              })
            }
            return mergeEvidenceEffect([
              ...proposed.evidence,
              selectionEvidence(selection, evidenceId),
            ]).pipe(
              Effect.map((evidence) => {
                const evidenceById = new Map(evidence.map((record) => [record.id, record]))
                const referencedIds = [
                  ...proposed.edits.flatMap((edit) => edit.evidenceIds),
                  ...(proposed.fileOperations ?? []).flatMap(
                    (operation) => operation.evidenceIds ?? [],
                  ),
                ]
                for (const id of referencedIds) {
                  if (!evidenceById.has(id)) {
                    evidenceById.set(id, {
                      id,
                      kind: "draft-operation",
                      facts: { source: "replaceEach" },
                    })
                  }
                }
                return {
                  edits: proposed.edits.map((edit) => ({
                    ...edit,
                    evidenceIds: [...new Set([...edit.evidenceIds, evidenceId])],
                  })),
                  fileOperations: (proposed.fileOperations ?? []).map((operation) => ({
                    ...operation,
                    evidenceIds: [...new Set([...(operation.evidenceIds ?? []), evidenceId])],
                  })),
                  evidence: [...evidenceById.values()],
                  matches: 1,
                }
              }),
            )
          }
          const node = isTextReplacement(proposed) ? selection.value : proposed.node
          const text = isTextReplacement(proposed) ? proposed : proposed.text
          const evidenceId = `selection:${selection.project.project.id}:${selection.fileName}:${selection.start}-${selection.end}`
          return editForNode(selection.project, node, text, { evidenceIds: [evidenceId] }).pipe(
            Effect.map((edit): Draft => ({
              edits: [edit],
              evidence: [selectionEvidence(selection, evidenceId)],
              matches: 1,
            })),
          )
        },
      ),
    )
  }).pipe(Effect.flatMap((drafts) => concatEffect(...drafts)))

const selectionEvidence = <A extends Node>(
  selection: Selection<A>,
  evidenceId: string,
): EvidenceRecord => ({
  id: evidenceId,
  kind: "selection",
  facts: {
    projectId: selection.project.project.id,
    fileName: selection.fileName,
    start: selection.start,
    end: selection.end,
    criteria: selection.evidence.map((item) => ({
      criterion: item.criterion,
      facts: { ...item.facts },
    })),
  },
})

// =============================================================================
// Read-only Audit Evidence
// =============================================================================

/**
 * Record query selections as search/audit evidence without proposing any file edits.
 * Enables read-only codebase audits, inventorying, and migration sizing.
 */
export const audit = <A extends Node>(selections: ReadonlyArray<Selection<A>>): Draft => {
  const evidence = mergeEvidence(
    selections.map((selection) => {
      const evidenceId = `selection:${selection.project.project.id}:${selection.fileName}:${selection.start}-${selection.end}`
      return selectionEvidence(selection, evidenceId)
    }),
  )
  return {
    edits: [],
    evidence,
    matches: evidence.length,
  }
}
