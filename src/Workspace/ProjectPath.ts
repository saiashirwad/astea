/** Compatibility exports. Import new host-path code from Node. */
export {
  InvalidProjectRelativePath,
  isProjectRelativePath,
  parseProjectRelativePath,
  requireProjectRelativePath,
} from "../ProjectPath/index.ts"
export type { ProjectRelativePath } from "../ProjectPath/index.ts"
/**
 * Compatibility façade for the historical Workspace public API.
 *
 * New Workspace implementation code uses WorkspaceRuntime instead.
 */
export {
  isWithinProject,
  projectRelativePath,
  resolveContainedSnapshotPath,
  resolveProjectRelativeFile,
} from "../Node/ProjectPath.ts"
