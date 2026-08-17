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
import { Effect, Predicate } from "effect"
import type { Node } from "typescript/unstable/ast"
import { textHash } from "../Edit/Hash.ts"
import type { TextEdit } from "../Edit/Model.ts"
import { nativeRequest, type NativeCompilerError } from "../Compiler/Service.ts"
import type { EvidenceRecord, PlannedFileOperation } from "../Plan/index.ts"
import { projectRelativePath } from "../Workspace/ProjectPath.ts"
import type { Selection } from "../Query/index.ts"
import type { ProjectSnapshot, SnapshotExpired } from "../Workspace/index.ts"

/** An edit in pre-finalization form; identical in shape to its durable counterpart. */
export type ProposedEdit = TextEdit

export interface Draft {
  readonly edits: ReadonlyArray<ProposedEdit>
  readonly fileOperations?: ReadonlyArray<PlannedFileOperation>
  readonly evidence: ReadonlyArray<EvidenceRecord>
  /** Number of selections that produced this draft; recorded as a planning-time measurement. */
  readonly matches: number
}

export const empty: Draft = { edits: [], fileOperations: [], evidence: [], matches: 0 }

/** Combine drafts built from disjoint selections. Conflicting overlaps are rejected at finalization. */
export const concat = (...drafts: ReadonlyArray<Draft>): Draft => ({
  edits: drafts.flatMap((draft) => [...draft.edits]),
  fileOperations: drafts.flatMap((draft) =>
    draft.fileOperations ? [...draft.fileOperations] : [],
  ),
  evidence: drafts.flatMap((draft) => [...draft.evidence]),
  matches: drafts.reduce((total, draft) => total + draft.matches, 0),
})

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

const draftOf = (
  edit: Effect.Effect<ProposedEdit, SnapshotExpired>,
  evidence: ReadonlyArray<EvidenceRecord>,
  matches: number,
) => Effect.map(edit, (proposed): Draft => ({ edits: [proposed], evidence, matches }))

/** Replace a node's source range with new text. */
export const replace = (
  project: ProjectSnapshot,
  node: Node,
  newText: string,
  options?: EditRangeOptions,
): Effect.Effect<Draft, SnapshotExpired> =>
  draftOf(editForNode(project, node, newText, options), [], 0)

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
      return {
        edits: [
          {
            projectId: project.project.id,
            fileName: projectRelativePath(project.root, sourceFile.fileName),
            start: position,
            end: position,
            expectedTextHash: textHash(""),
            newText: text,
            evidenceIds: [],
          },
        ],
        evidence: [],
        matches: 0,
      }
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

const isTextReplacement = (val: Replacement): val is string => typeof val === "string"

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
): Effect.Effect<Draft, E | SnapshotExpired, R> =>
  Effect.forEach(selections, (selection) => {
    const raw = replacement(selection)
    const effect = Effect.isEffect(raw) ? raw : Effect.succeed(raw)
    return effect.pipe(
      Effect.flatMap((proposed) => {
        if (isDraft(proposed)) {
          const evidenceId = `selection:${selection.project.project.id}:${selection.fileName}:${selection.start}-${selection.end}`
          const evidence =
            proposed.evidence.length > 0
              ? proposed.evidence
              : [
                  {
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
                  },
                ]
          return Effect.succeed({
            ...proposed,
            evidence,
            matches: proposed.matches > 0 ? proposed.matches : 1,
          })
        }
        const node = isTextReplacement(proposed) ? selection.value : proposed.node
        const text = isTextReplacement(proposed) ? proposed : proposed.text
        const evidenceId = `selection:${selection.project.project.id}:${selection.fileName}:${selection.start}-${selection.end}`
        return editForNode(selection.project, node, text, { evidenceIds: [evidenceId] }).pipe(
          Effect.map((edit): Draft => ({
            edits: [edit],
            evidence: [
              {
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
              },
            ],
            matches: 1,
          })),
        )
      }),
    )
  }).pipe(Effect.map((drafts) => concat(...drafts)))

// =============================================================================
// Read-only Audit Evidence
// =============================================================================

/**
 * Record query selections as search/audit evidence without proposing any file edits.
 * Enables read-only codebase audits, inventorying, and migration sizing.
 */
export const audit = <A extends Node>(selections: ReadonlyArray<Selection<A>>): Draft => {
  const evidence: Array<EvidenceRecord> = selections.map((selection) => {
    const evidenceId = `selection:${selection.project.project.id}:${selection.fileName}:${selection.start}-${selection.end}`
    return {
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
    }
  })
  return {
    edits: [],
    evidence,
    matches: selections.length,
  }
}
