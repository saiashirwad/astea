/** Native compiler filesystem options for an isolated virtual snapshot. */
import type { APIOptions } from "typescript/unstable/async"
import type { VirtualFsSnapshot } from "../../VirtualFs/index.ts"
import type { SnapshotTransition } from "../Model.ts"
import type { WorkspaceRuntimeService } from "../Runtime.ts"

export interface CompilerOverlay {
  readonly options: APIOptions
  readonly transition: SnapshotTransition
}

interface WorkspaceFileChanges {
  changed?: ReadonlyArray<string>
  created?: ReadonlyArray<string>
  deleted?: ReadonlyArray<string>
}

/** Build the compiler overlay without writing to the workspace. */
export const compilerOverlayFor = (
  runtime: WorkspaceRuntimeService,
  root: string,
  apiOptions: APIOptions,
  overlay: VirtualFsSnapshot,
): CompilerOverlay => {
  const deleted = overlay.deleted
  const created = overlay.created
  const matchesVirtualPath = (observed: string, planned: string): boolean => {
    if (observed === planned) return true
    const relative = runtime.relativePath(root, planned)
    return (
      relative !== "" &&
      !relative.startsWith("..") &&
      !runtime.isAbsolutePath(relative) &&
      observed.endsWith(`${runtime.pathSeparator}${relative}`)
    )
  }

  const options: APIOptions = {
    ...apiOptions,
    fs: {
      ...apiOptions.fs,
      getAccessibleEntries: (directoryName) => {
        const delegated = apiOptions.fs?.getAccessibleEntries?.(directoryName)
        const existing =
          delegated ??
          (() => {
            try {
              return runtime.directoryEntries(directoryName)
            } catch {
              return undefined
            }
          })()
        const isDeleted = (entry: string) => {
          const absolute = runtime.resolvePath(directoryName, entry)
          return [...deleted].some((path) => matchesVirtualPath(absolute, path))
        }
        const files = new Set((existing?.files ?? []).filter((entry) => !isDeleted(entry)))
        const directories = new Set(
          (existing?.directories ?? []).filter((entry) => !isDeleted(entry)),
        )
        for (const plannedFileName of overlay.files.keys()) {
          const relative = runtime.relativePath(directoryName, plannedFileName)
          if (relative === "" || relative.startsWith("..") || runtime.isAbsolutePath(relative))
            continue
          const first = relative.split(runtime.pathSeparator)[0]!
          if (first === relative) files.add(first)
          else directories.add(first)
        }
        return existing === undefined && files.size === 0 && directories.size === 0
          ? undefined
          : { files: [...files], directories: [...directories] }
      },
      readFile: (fileName) => {
        for (const plannedFileName of deleted) {
          if (matchesVirtualPath(fileName, plannedFileName)) return null
        }
        const exact = overlay.files.get(fileName)
        if (exact !== undefined) return exact
        for (const [plannedFileName, content] of overlay.files) {
          if (matchesVirtualPath(fileName, plannedFileName)) return content
        }
        return apiOptions.fs?.readFile?.(fileName)
      },
      fileExists: (fileName) => {
        for (const plannedFileName of deleted) {
          if (matchesVirtualPath(fileName, plannedFileName)) return false
        }
        if (overlay.files.has(fileName)) return true
        for (const plannedFileName of overlay.files.keys()) {
          if (matchesVirtualPath(fileName, plannedFileName)) return true
        }
        return apiOptions.fs?.fileExists?.(fileName)
      },
    },
  }

  const changed = [...overlay.files.keys()].filter(
    (path) => !created.has(path) && !deleted.has(path),
  )
  const fileChanges: WorkspaceFileChanges = {}
  if (changed.length > 0) fileChanges.changed = changed
  if (created.size > 0) fileChanges.created = [...created]
  if (deleted.size > 0) fileChanges.deleted = [...deleted]

  return {
    options,
    transition: Object.keys(fileChanges).length > 0 ? { changes: fileChanges } : {},
  }
}
