import { path as Path } from "../../platform/node.ts"
import { Effect } from "effect"
import type { SourceFile } from "typescript/unstable/ast"
import type { Project as NativeProject } from "typescript/unstable/async"
import { nativeRequest } from "../../Compiler/Service.ts"
import { projectRelativePath } from "../ProjectPath.ts"

interface ProjectDependencyGraph {
  readonly forward: Map<string, Set<string>>
  readonly reverse: Map<string, Set<string>>
}

const traverseGraph = (
  adjacency: Map<string, Set<string>>,
  startPath: string,
  transitive: boolean,
): ReadonlyArray<string> => {
  if (!transitive) return [...(adjacency.get(startPath) ?? [])].sort()

  const visited = new Set<string>([startPath])
  const result: Array<string> = []
  const queue = [...(adjacency.get(startPath) ?? [])]
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!
    if (visited.has(current)) continue
    visited.add(current)
    result.push(current)
    queue.push(...(adjacency.get(current) ?? []))
  }
  return result.sort()
}

export const makeDependencyGraphNavigation = <E>(options: {
  readonly nativeProject: NativeProject
  readonly projectRoot: string
  readonly ensureActive: Effect.Effect<void, E>
}) => {
  const { nativeProject, projectRoot, ensureActive } = options
  let memoizedGraph: ProjectDependencyGraph | undefined

  const getDependencyGraph = Effect.gen(function*() {
    yield* ensureActive
    if (memoizedGraph !== undefined) return memoizedGraph

    const allFileNames = yield* nativeRequest("getSourceFileNames", () => nativeProject.program.getSourceFileNames())
    const canonicalMap = new Map<string, string>()
    const projectFiles: Array<{ fn: string; rel: string; sf: SourceFile }> = []
    for (const fn of allFileNames) {
      const sf = yield* nativeRequest("getSourceFile", () => nativeProject.program.getSourceFile(fn))
      if (sf === undefined) continue
      const isDefault = yield* nativeRequest("isSourceFileDefaultLibrary", () => nativeProject.program.isSourceFileDefaultLibrary(sf))
      const isExternal = yield* nativeRequest("isSourceFileFromExternalLibrary", () => nativeProject.program.isSourceFileFromExternalLibrary(sf))
      if (!isDefault && !isExternal) {
        const rel = projectRelativePath(projectRoot, fn)
        canonicalMap.set(Path.resolve(fn).toLowerCase(), rel)
        projectFiles.push({ fn, rel, sf })
      }
    }

    const forward = new Map<string, Set<string>>()
    const reverse = new Map<string, Set<string>>()
    for (const { rel } of projectFiles) {
      forward.set(rel, new Set())
      reverse.set(rel, new Set())
    }

    const addEdge = (from: string, to: string | undefined) => {
      if (to !== undefined && to !== from) {
        forward.get(from)?.add(to)
        reverse.get(to)?.add(from)
      }
    }
    for (const { fn, rel, sf } of projectFiles) {
      if (sf.imports !== undefined && sf.imports.length > 0) {
        const symbols = yield* nativeRequest("getSymbolAtLocation", () => nativeProject.checker.getSymbolAtLocation(sf.imports))
        for (const symbol of Array.isArray(symbols) ? symbols : [symbols]) {
          if (symbol === undefined) continue
          const declarations = [symbol.valueDeclaration, ...(symbol.declarations ?? [])].filter(
            (declaration): declaration is NonNullable<typeof declaration> => declaration !== undefined,
          )
          for (const declaration of declarations) {
            if (declaration.path !== undefined) {
              addEdge(rel, canonicalMap.get(Path.resolve(declaration.path).toLowerCase()))
            }
          }
        }
      }
      for (const reference of sf.referencedFiles ?? []) {
        if (reference.fileName !== undefined) {
          addEdge(rel, canonicalMap.get(Path.resolve(Path.dirname(fn), reference.fileName).toLowerCase()))
        }
      }
    }

    memoizedGraph = { forward, reverse }
    return memoizedGraph
  })

  return (relativePath: string, direction: "forward" | "reverse", transitive: boolean) =>
    Effect.gen(function*() {
      yield* ensureActive
      const graph = yield* getDependencyGraph
      return traverseGraph(graph[direction], relativePath, transitive)
    })
}
