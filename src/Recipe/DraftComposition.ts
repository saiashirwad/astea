/** Sequential Draft composition. */
import { Effect } from "effect"
import {
  applyFileEdits,
  textHash,
  type EditConflict,
  type InvalidEdit,
  type TextEdit,
} from "../Edit/index.ts"
import * as Draft from "../Draft/index.ts"
import type { Draft as DraftModel, DraftEvidenceConflict } from "../Draft/index.ts"
import type { PlannedFileOperation } from "../Plan/index.ts"
import type {
  FileNotFound,
  ProjectNotInSnapshot,
  ProjectSnapshotError,
  WorkspaceSnapshotService,
} from "../Workspace/index.ts"

/** Collapse two sequential Drafts into one Draft against the original snapshot. */
export const composeDrafts = (
  snapshot: WorkspaceSnapshotService,
  accumulated: DraftModel,
  next: DraftModel,
): Effect.Effect<
  DraftModel,
  | ProjectSnapshotError
  | ProjectNotInSnapshot
  | FileNotFound
  | InvalidEdit
  | EditConflict
  | DraftEvidenceConflict
> =>
  Effect.gen(function* () {
    const accumulatedChanged =
      accumulated.edits.length > 0 || (accumulated.fileOperations?.length ?? 0) > 0
    const nextChanged = next.edits.length > 0 || (next.fileOperations?.length ?? 0) > 0
    const retained = {
      evidence: yield* Draft.mergeEvidenceEffect([...accumulated.evidence, ...next.evidence]),
      matches: accumulated.matches + next.matches,
    }
    if (!accumulatedChanged) return { ...next, ...retained }
    if (!nextChanged) return { ...accumulated, ...retained }

    const accumulatedByFile = Map.groupBy(accumulated.edits, (e) => `${e.projectId}\0${e.fileName}`)
    const nextByFile = Map.groupBy(next.edits, (e) => `${e.projectId}\0${e.fileName}`)
    const allKeys = new Set([...accumulatedByFile.keys(), ...nextByFile.keys()])
    const combinedEdits: Array<TextEdit> = []

    for (const key of allKeys) {
      const accEdits = accumulatedByFile.get(key)
      const nxtEdits = nextByFile.get(key)

      if (accEdits && !nxtEdits) {
        combinedEdits.push(...accEdits)
      } else if (!accEdits && nxtEdits) {
        combinedEdits.push(...nxtEdits)
      } else if (accEdits && nxtEdits) {
        // SAFETY: Edit-map keys contain the project ID and file name by construction.
        const [projectId, fileName] = key.split("\0") as [string, string]
        const projectDef = snapshot.projects.find((p) => p.id === projectId)
        if (!projectDef) continue
        const project = yield* snapshot.project(projectDef)
        const t0 = yield* project.sourceText(fileName)
        const t1 = yield* applyFileEdits(t0, accEdits)
        const t2 = yield* applyFileEdits(t1, nxtEdits)

        if (t0 === t2) continue

        let start = 0
        while (start < t0.length && start < t2.length && t0[start] === t2[start]) start++

        let end0 = t0.length
        let end2 = t2.length
        while (end0 > start && end2 > start && t0[end0 - 1] === t2[end2 - 1]) {
          end0--
          end2--
        }

        combinedEdits.push({
          projectId,
          fileName,
          start,
          end: end0,
          expectedTextHash: textHash(t0.slice(start, end0)),
          newText: t2.slice(start, end2),
          evidenceIds: [
            ...new Set([
              ...accEdits.flatMap((edit) => edit.evidenceIds),
              ...nxtEdits.flatMap((edit) => edit.evidenceIds),
            ]),
          ],
        })
      }
    }

    const fileOperations = [...(accumulated.fileOperations ?? []), ...(next.fileOperations ?? [])]
    const consumed = new Set<string>()
    const normalizedOperations: Array<PlannedFileOperation> = []
    for (const operation of fileOperations) {
      const sourceKey = `${operation.projectId}\0${operation.path}`
      const targetKey =
        operation.kind === "move" ? `${operation.projectId}\0${operation.toPath}` : undefined
      const operationEditKey = operation.kind === "move" ? targetKey : sourceKey
      const operationEdits =
        operationEditKey === undefined
          ? undefined
          : combinedEdits.filter(
              (edit) => `${edit.projectId}\0${edit.fileName}` === operationEditKey,
            )
      let normalized = operation
      if (operationEdits !== undefined && operationEdits.length > 0) {
        consumed.add(operationEditKey!)
        if (operation.kind === "create" || operation.kind === "move") {
          const content = yield* applyFileEdits(operation.content ?? "", operationEdits)
          normalized = { ...operation, content }
        }
      }

      if (operation.kind === "delete" || operation.kind === "move") {
        const producerIndex = normalizedOperations.findIndex(
          (candidate) =>
            candidate.projectId === operation.projectId &&
            ((candidate.kind === "create" && candidate.path === operation.path) ||
              (candidate.kind === "move" && candidate.toPath === operation.path)),
        )
        const producer = normalizedOperations[producerIndex]
        if (producer !== undefined && (producer.kind === "create" || producer.kind === "move")) {
          const evidenceIds = [
            ...new Set([...(producer.evidenceIds ?? []), ...(operation.evidenceIds ?? [])]),
          ]
          consumed.add(sourceKey)
          if (operation.kind === "delete") {
            normalizedOperations.splice(producerIndex, 1)
          } else if (producer.kind === "create") {
            normalizedOperations[producerIndex] = {
              kind: "create",
              projectId: producer.projectId,
              path: operation.toPath,
              content:
                normalized.kind === "move" && normalized.content !== undefined
                  ? normalized.content
                  : producer.content,
              evidenceIds,
            }
          } else {
            normalizedOperations[producerIndex] = {
              kind: "move",
              projectId: producer.projectId,
              path: producer.path,
              toPath: operation.toPath,
              initialHash: producer.initialHash,
              content:
                normalized.kind === "move" && normalized.content !== undefined
                  ? normalized.content
                  : producer.content,
              evidenceIds,
            }
          }
          if (operation.kind === "move") consumed.add(targetKey!)
          continue
        }
      }

      if (normalized.kind === "delete" || normalized.kind === "move") {
        const configured = snapshot.projects.find((project) => project.id === normalized.projectId)
        if (configured !== undefined) {
          const project = yield* snapshot.project(configured)
          const original = yield* project.sourceText(normalized.path)
          normalized = { ...normalized, initialHash: textHash(original) }
        }
      }
      if (operation.kind === "delete" || operation.kind === "move") consumed.add(sourceKey)
      normalizedOperations.push(normalized)
    }

    return {
      edits: combinedEdits.filter((edit) => !consumed.has(`${edit.projectId}\0${edit.fileName}`)),
      fileOperations: normalizedOperations,
      evidence: yield* Draft.mergeEvidenceEffect([...accumulated.evidence, ...next.evidence]),
      matches: accumulated.matches + next.matches,
    }
  })
