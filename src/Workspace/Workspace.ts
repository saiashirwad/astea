/** Public assembly for Workspace values, snapshot regions, and services. */
export {
  ConfiguredProject,
  DuplicateConfiguredProject,
  FileNotFound,
  isProjectFile,
  ProjectFileTypeSymbol,
  ProjectNotInSnapshot,
  SnapshotExpired,
  SymbolNotFound,
} from "./Model.ts"
export type {
  DependencyGraphOptions,
  ProjectFile,
  ProjectSnapshot,
  ProjectSnapshotError,
  SnapshotTransition,
  WorkspaceChanges,
  WorkspaceDefinition,
} from "./Model.ts"
export { WorkspaceSnapshot } from "./SnapshotRegion.ts"
export type { WorkspaceSnapshotService } from "./SnapshotRegion.ts"
export { WorkspaceRuntime } from "./Runtime.ts"
export type { WorkspaceDirectoryEntries, WorkspaceRuntimeService } from "./Runtime.ts"
export { layer, layerWithoutDependencies, make, Workspace } from "./Service.ts"
export type { WorkspaceService } from "./Service.ts"

export type { NativeCompilerError } from "../Compiler/Service.ts"
export type { CompilerObservation, CompilerObservationKind } from "./internal/ObservedInputs.ts"
export { hashDirectoryListing } from "./internal/ObservedInputs.ts"
