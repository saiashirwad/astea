/** Record compiler filesystem observations for the Snapshot Input Manifest. */
import { createHash } from "node:crypto"
import { Predicate } from "effect"
import { nodeFs as Fs } from "../../platform/node.ts"
import type { APIOptions } from "typescript/unstable/async"

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
    try {
      const content = Fs.readFileSync(fileName, "utf8")
      record({ kind: "file", path: fileName, hash: contentHash(content) })
      return content
    } catch {
      return undefined
    }
  },
  fileExists: (fileName) => {
    const delegated = base?.fileExists?.(fileName)
    if (delegated === false) {
      record({ kind: "missing", path: fileName, hash: "" })
      return false
    }
    if (delegated === true) return true
    try {
      const exists = Fs.existsSync(fileName) && Fs.statSync(fileName).isFile()
      if (!exists) record({ kind: "missing", path: fileName, hash: "" })
      return exists
    } catch {
      return undefined
    }
  },
  directoryExists: (directoryName) => {
    const delegated = base?.directoryExists?.(directoryName)
    if (delegated !== undefined) return delegated
    try {
      return Fs.statSync(directoryName).isDirectory()
    } catch {
      return undefined
    }
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
    try {
      const entries = Fs.readdirSync(directoryName, { withFileTypes: true })
      const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
      const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      record({
        kind: "directory",
        path: directoryName,
        hash: hashDirectoryListing([...files, ...directories]),
      })
      return { files, directories }
    } catch {
      return undefined
    }
  },
  realpath: (value) => {
    const delegated = base?.realpath?.(value)
    if (delegated !== undefined) {
      record({ kind: "realpath", path: value, hash: contentHash(delegated) })
      return delegated
    }
    try {
      const resolved = Fs.realpathSync(value)
      record({ kind: "realpath", path: value, hash: contentHash(resolved) })
      return resolved
    } catch {
      return undefined
    }
  },
})

export const attachInputObserver = (options: APIOptions): APIOptions => {
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
  const fs = Object.assign(observeFileSystem(options.fs, record), {
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
