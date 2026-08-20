/** Record compiler filesystem observations for the Snapshot Input Manifest. */
import { createHash } from "node:crypto"
import { Predicate } from "effect"
import type { APIOptions } from "typescript/unstable/async"
import type { WorkspaceRuntimeService } from "../Runtime.ts"

export type CompilerObservationKind = "file" | "missing" | "directory" | "realpath"

export interface CompilerObservation {
  readonly kind: CompilerObservationKind
  readonly path: string
  readonly hash: string
}

export interface InputObserver {
  readonly reset: () => void
  readonly snapshot: () => ReadonlyArray<CompilerObservation>
}

const InputObserverId: unique symbol = Symbol.for("@safemods/InputObserver")

type HostFileSystem = NonNullable<APIOptions["fs"]>

interface ObservedFileSystem extends HostFileSystem {
  readonly [InputObserverId]: InputObserver
}

export const hashDirectoryListing = (names: ReadonlyArray<string>): string =>
  createHash("sha256")
    .update(JSON.stringify([...names].sort()))
    .digest("hex")

const contentHash = (text: string): string => createHash("sha256").update(text).digest("hex")

const observeFileSystem = (
  base: HostFileSystem | undefined,
  runtime: WorkspaceRuntimeService,
  record: (observation: CompilerObservation) => void,
): HostFileSystem => ({
  ...base,
  readFile: (fileName) => {
    const delegated = base?.readFile?.(fileName)
    if (delegated === null) {
      record({ kind: "missing", path: fileName, hash: "" })
      return null
    }
    if (Predicate.isString(delegated)) {
      record({ kind: "file", path: fileName, hash: contentHash(delegated) })
      return delegated
    }
    const content = runtime.readFileText(fileName)
    if (content !== undefined) {
      record({ kind: "file", path: fileName, hash: contentHash(content) })
      return content
    }
    return undefined
  },
  fileExists: (fileName) => {
    const delegated = base?.fileExists?.(fileName)
    if (delegated === false) {
      record({ kind: "missing", path: fileName, hash: "" })
      return false
    }
    if (delegated === true) return true
    const exists = runtime.fileExists(fileName)
    if (exists === false) record({ kind: "missing", path: fileName, hash: "" })
    return exists
  },
  directoryExists: (directoryName) => {
    const delegated = base?.directoryExists?.(directoryName)
    if (delegated !== undefined) return delegated
    return runtime.directoryExists(directoryName)
  },
  getAccessibleEntries: (directoryName) => {
    const delegated = base?.getAccessibleEntries?.(directoryName)
    if (delegated !== undefined) {
      record({
        kind: "directory",
        path: directoryName,
        hash: hashDirectoryListing([...delegated.files, ...delegated.directories]),
      })
      return delegated
    }
    const entries = runtime.directoryEntries(directoryName)
    if (entries !== undefined) {
      const { files, directories } = entries
      record({
        kind: "directory",
        path: directoryName,
        hash: hashDirectoryListing([...files, ...directories]),
      })
      return { files: [...files], directories: [...directories] }
    }
    return undefined
  },
  realpath: (value) => {
    const delegated = base?.realpath?.(value)
    if (delegated !== undefined) {
      record({ kind: "realpath", path: value, hash: contentHash(delegated) })
      return delegated
    }
    const resolved = runtime.realPath(value)
    if (resolved !== undefined) {
      record({ kind: "realpath", path: value, hash: contentHash(resolved) })
      return resolved
    }
    return undefined
  },
})

export const attachInputObserver = (
  options: APIOptions,
  runtime: WorkspaceRuntimeService,
): APIOptions => {
  const observations = new Map<string, CompilerObservation>()
  const observer: InputObserver = {
    reset: () => {
      observations.clear()
    },
    snapshot: () =>
      [...observations.values()].sort(
        (left, right) => left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path),
      ),
  }
  const record = (observation: CompilerObservation) => {
    observations.set(`${observation.kind}\0${observation.path}`, observation)
  }
  const fs = Object.assign(observeFileSystem(options.fs, runtime, record), {
    [InputObserverId]: observer,
  })
  return { ...options, fs }
}

export const inputObserverOf = (fs: APIOptions["fs"]): InputObserver | undefined => {
  if (fs !== undefined && InputObserverId in fs) {
    // SAFETY: the branded property is installed by attachInputObserver above.
    return (fs as ObservedFileSystem)[InputObserverId]
  }
  return undefined
}
