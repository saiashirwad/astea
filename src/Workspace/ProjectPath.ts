/** Compatibility exports. Import new code from ProjectPath or Node. */
export {
  InvalidProjectRelativePath,
  isProjectRelativePath,
  parseProjectRelativePath,
  requireProjectRelativePath,
} from "../ProjectPath/index.ts"
export type { ProjectRelativePath } from "../ProjectPath/index.ts"
export {
  isWithinProject,
  projectRelativePath,
  resolveContainedSnapshotPath,
  resolveProjectRelativeFile,
} from "../Node/ProjectPath.ts"
