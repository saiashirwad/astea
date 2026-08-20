/** Synchronous host operations required by TypeScript compiler callbacks. */
import { Context } from "effect"

export interface WorkspaceDirectoryEntries {
  readonly files: ReadonlyArray<string>
  readonly directories: ReadonlyArray<string>
}

/** Runtime authority for synchronous TypeScript compiler-host callbacks. */
export interface WorkspaceRuntimeService {
  readonly resolvePath: (...paths: ReadonlyArray<string>) => string
  readonly dirname: (path: string) => string
  readonly relativePath: (from: string, to: string) => string
  readonly isAbsolutePath: (path: string) => boolean
  readonly pathSeparator: string
  readonly readFileText: (path: string) => string | undefined
  readonly fileExists: (path: string) => boolean | undefined
  readonly directoryExists: (path: string) => boolean | undefined
  readonly directoryEntries: (path: string) => WorkspaceDirectoryEntries | undefined
  readonly realPath: (path: string) => string | undefined
}

export class WorkspaceRuntime extends Context.Service<WorkspaceRuntime, WorkspaceRuntimeService>()(
  // oxlint-disable-next-line effecttsgo/deterministic-keys -- Stable internal service identifier.
  "@safemods/internal/WorkspaceRuntime",
) {}
