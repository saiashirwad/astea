/** Node implementation of Workspace's synchronous compiler-host runtime. */
import * as Fs from "node:fs"
import * as Path from "node:path"
import { Layer } from "effect"
import type { APIOptions } from "typescript/unstable/async"
import { Workspace, type WorkspaceDefinition } from "../Workspace/index.ts"
import { WorkspaceRuntime } from "../Workspace/Runtime.ts"

export const workspaceRuntimeLayer = Layer.sync(WorkspaceRuntime, () =>
  WorkspaceRuntime.of({
    resolvePath: (...paths) => Path.resolve(...paths),
    dirname: Path.dirname,
    relativePath: Path.relative,
    isAbsolutePath: Path.isAbsolute,
    pathSeparator: Path.sep,
    readFileText: (path) => {
      try {
        return Fs.readFileSync(path, "utf8")
      } catch {
        return undefined
      }
    },
    fileExists: (path) => {
      try {
        return Fs.existsSync(path) && Fs.statSync(path).isFile()
      } catch {
        return undefined
      }
    },
    directoryExists: (path) => {
      try {
        return Fs.statSync(path).isDirectory()
      } catch {
        return undefined
      }
    },
    directoryEntries: (path) => {
      try {
        const entries = Fs.readdirSync(path, { withFileTypes: true })
        return {
          files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
          directories: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
        }
      } catch {
        return undefined
      }
    },
    realPath: (path) => {
      try {
        return Fs.realpathSync(path)
      } catch {
        return undefined
      }
    },
  }),
)

/** Ready Node-backed Workspace layer for normal application composition. */
export const workspaceLayerNode = (definition: WorkspaceDefinition, options: APIOptions = {}) =>
  Workspace.layer(definition, options).pipe(Layer.provide(workspaceRuntimeLayer))
