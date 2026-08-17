import { Data, Effect } from "effect"
import {
  applyFileEdits,
  textHash,
  type EditConflict,
  type InvalidEdit,
  type TextEdit,
} from "../Edit/index.ts"
import type { PlannedFileOperation } from "../Plan/index.ts"

/** The complete virtual filesystem state presented to an isolated compiler. */
export interface VirtualFsSnapshot {
  /** Absolute path to modified or newly-created content. */
  readonly files: ReadonlyMap<string, string>
  /** Absolute paths created by the materialized operations. */
  readonly created: ReadonlySet<string>
  /** Absolute paths deleted by the materialized operations. */
  readonly deleted: ReadonlySet<string>
}

export interface VirtualFsInitialFile {
  readonly projectId: string
  readonly fileName: string
  readonly content: string
}

export class VirtualFsError extends Data.TaggedError("VirtualFsError")<{
  readonly reason: "missing-source" | "source-mismatch"
  readonly projectId: string
  readonly fileName: string
  readonly expectedHash?: string
  readonly actualHash?: string
}> {}

export interface VirtualFsMaterializeOptions<E> {
  readonly initialFiles?: ReadonlyArray<VirtualFsInitialFile>
  readonly load: (projectId: string, fileName: string) => Effect.Effect<string, E>
  readonly resolvePath: (projectId: string, fileName: string) => string
  readonly edits: ReadonlyArray<TextEdit>
  readonly fileOperations?: ReadonlyArray<PlannedFileOperation>
}

export const virtualFileKey = (projectId: string, fileName: string): string =>
  `${projectId}\0${fileName}`

export const emptySnapshot = (): VirtualFsSnapshot => ({
  files: new Map(),
  created: new Set(),
  deleted: new Set(),
})

interface VirtualFile {
  readonly projectId: string
  readonly fileName: string
  content: string
  exists: boolean
}

/**
 * Apply file operations and text edits to one coherent virtual filesystem.
 * Operations are applied first, in declaration order, followed by grouped
 * text edits. This is the only state machine used by overlays and previews.
 */
export const materialize = <E>(
  options: VirtualFsMaterializeOptions<E>,
): Effect.Effect<VirtualFsSnapshot, E | VirtualFsError | InvalidEdit | EditConflict> =>
  Effect.gen(function* () {
    const state = new Map<string, VirtualFile>()
    for (const initial of options.initialFiles ?? []) {
      state.set(virtualFileKey(initial.projectId, initial.fileName), {
        projectId: initial.projectId,
        fileName: initial.fileName,
        content: initial.content,
        exists: true,
      })
    }

    const created = new Set<string>()
    const deleted = new Set<string>()
    const touched = new Set<string>()

    const load = (projectId: string, fileName: string) =>
      Effect.gen(function* () {
        const key = virtualFileKey(projectId, fileName)
        const existing = state.get(key)
        if (existing !== undefined) return existing
        const value: VirtualFile = {
          projectId,
          fileName,
          content: yield* options.load(projectId, fileName),
          exists: true,
        }
        state.set(key, value)
        return value
      })

    const requireExisting = (projectId: string, fileName: string) =>
      Effect.gen(function* () {
        const file = yield* load(projectId, fileName)
        if (!file.exists) {
          return yield* new VirtualFsError({ reason: "missing-source", projectId, fileName })
        }
        return file
      })

    for (const operation of options.fileOperations ?? []) {
      const sourcePath = options.resolvePath(operation.projectId, operation.path)
      const sourceKey = virtualFileKey(operation.projectId, operation.path)
      touched.add(sourceKey)

      if (operation.kind === "create") {
        state.set(sourceKey, {
          projectId: operation.projectId,
          fileName: operation.path,
          content: operation.content,
          exists: true,
        })
        deleted.delete(sourcePath)
        created.add(sourcePath)
        continue
      }

      const current = yield* requireExisting(operation.projectId, operation.path)
      const actualHash = textHash(current.content)
      if (actualHash !== operation.initialHash) {
        return yield* new VirtualFsError({
          reason: "source-mismatch",
          projectId: operation.projectId,
          fileName: operation.path,
          expectedHash: operation.initialHash,
          actualHash,
        })
      }

      if (operation.kind === "delete") {
        current.exists = false
        deleted.add(sourcePath)
        created.delete(sourcePath)
        continue
      }

      const targetPath = options.resolvePath(operation.projectId, operation.toPath)
      touched.add(virtualFileKey(operation.projectId, operation.toPath))
      current.exists = false
      state.set(virtualFileKey(operation.projectId, operation.toPath), {
        projectId: operation.projectId,
        fileName: operation.toPath,
        content: operation.content ?? current.content,
        exists: true,
      })
      deleted.add(sourcePath)
      deleted.delete(targetPath)
      created.add(targetPath)
    }

    const grouped = Map.groupBy(options.edits, (edit) =>
      virtualFileKey(edit.projectId, edit.fileName),
    )
    for (const group of grouped.values()) {
      const first = group[0]!
      touched.add(virtualFileKey(first.projectId, first.fileName))
      const current = yield* load(first.projectId, first.fileName)
      // Deletion is terminal: edits authored before a delete cannot resurrect it.
      if (!current.exists) continue
      current.content = yield* applyFileEdits(current.content, group)
    }

    const files = new Map<string, string>()
    for (const value of state.values()) {
      if (touched.has(virtualFileKey(value.projectId, value.fileName)) && value.exists) {
        files.set(options.resolvePath(value.projectId, value.fileName), value.content)
      }
    }

    return { files, created, deleted }
  })
