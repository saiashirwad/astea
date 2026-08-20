/** Native compiler filesystem options for an isolated virtual snapshot. */
import { nodeFs as Fs, path as Path } from "../../platform/node.ts"
import type { APIOptions } from "typescript/unstable/async"
import type { VirtualFsSnapshot } from "../../VirtualFs/index.ts"
import type { SnapshotTransition } from "../Model.ts"

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
  root: string,
  apiOptions: APIOptions,
  overlay: VirtualFsSnapshot,
): CompilerOverlay => {
  const deleted = overlay.deleted
  const created = overlay.created
  const matchesVirtualPath = (observed: string, planned: string): boolean => {
    if (observed === planned) return true
    const relative = Path.relative(root, planned)
    return (
      relative !== "" &&
      !relative.startsWith("..") &&
      !Path.isAbsolute(relative) &&
      observed.endsWith(`${Path.sep}${relative}`)
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
              const entries = Fs.readdirSync(directoryName, { withFileTypes: true })
              return {
                files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
                directories: entries
                  .filter((entry) => entry.isDirectory())
                  .map((entry) => entry.name),
              }
            } catch {
              return undefined
            }
          })()
        const isDeleted = (entry: string) => {
          const absolute = Path.resolve(directoryName, entry)
          return [...deleted].some((path) => matchesVirtualPath(absolute, path))
        }
        const files = new Set((existing?.files ?? []).filter((entry) => !isDeleted(entry)))
        const directories = new Set(
          (existing?.directories ?? []).filter((entry) => !isDeleted(entry)),
        )
        for (const plannedFileName of overlay.files.keys()) {
          const relative = Path.relative(directoryName, plannedFileName)
          if (relative === "" || relative.startsWith("..") || Path.isAbsolute(relative)) continue
          const first = relative.split(Path.sep)[0]!
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
