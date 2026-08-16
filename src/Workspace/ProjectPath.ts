/** Workspace project-relative path identity. */
import { path as Path } from "../platform/node.ts"

export const isWithinProject = (projectRoot: string, fileName: string): boolean => {
  const root = Path.resolve(projectRoot)
  const file = Path.resolve(fileName)
  return file.toLowerCase().startsWith(`${root.toLowerCase()}${Path.sep}`)
}

export const projectRelativePath = (projectRoot: string, fileName: string): string => {
  const root = Path.resolve(projectRoot)
  const file = Path.resolve(fileName)
  if (file.toLowerCase().startsWith(`${root.toLowerCase()}${Path.sep}`)) {
    return file.slice(root.length + 1)
  }
  return Path.relative(root, file)
}
