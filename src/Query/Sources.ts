/** Query sources over workspace snapshots and structural patterns. */
import { Effect, Stream } from "effect"
import {
  SyntaxKind,
  type CallExpression,
  type Identifier,
  type ImportDeclaration,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
} from "typescript/unstable/ast"
import {
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isPropertyAccessExpression,
} from "typescript/unstable/ast/is"
import { nativeRequest } from "../Compiler/Service.ts"
import {
  isProjectFile,
  type ProjectFile,
  type ProjectSnapshot,
  type ProjectSnapshotError,
} from "../Workspace/index.ts"
import type { Pattern, SyntaxKindFilter } from "../Pattern/index.ts"
import type { ProjectScope, Query, Selection, TargetFileScope } from "./Model.ts"

const isProjectFileArray = (value: ProjectScope): value is ReadonlyArray<ProjectFile> =>
  Array.isArray(value)

const resolveScope = (
  scope: ProjectScope,
): Stream.Stream<TargetFileScope, ProjectSnapshotError> => {
  if (isProjectFileArray(scope)) {
    if (scope.length === 0) {
      return Stream.empty
    }
    const seen = new Set<string>()
    const uniqueFiles: Array<TargetFileScope> = []
    for (const f of scope) {
      const key = `${f.project.project.id}:${f.path}`
      const fileName = f.project.resolveFileName(f.path)
      if (!seen.has(key) && f.project.containsFileName(fileName)) {
        seen.add(key)
        uniqueFiles.push({
          project: f.project,
          fileName,
        })
      }
    }
    return Stream.fromIterable(uniqueFiles)
  }
  if (isProjectFile(scope)) {
    const fileName = scope.project.resolveFileName(scope.path)
    return scope.project.containsFileName(fileName)
      ? Stream.make({
          project: scope.project,
          fileName,
        })
      : Stream.empty
  }
  return Stream.fromIterableEffect(
    scope.files.pipe(
      Effect.map((projectFiles) =>
        projectFiles.flatMap((file) => {
          const fileName = file.project.resolveFileName(file.path)
          return file.project.containsFileName(fileName) ? [{ project: scope, fileName }] : []
        }),
      ),
    ),
  )
}

const collectNodes = <A extends Node>(
  project: ProjectSnapshot,
  sourceFile: SourceFile,
  requestedFileName: string,
  guard: (node: Node) => node is A,
  syntaxKind?: SyntaxKindFilter,
): Array<Selection<A>> => {
  const selections: Array<Selection<A>> = []
  const fileName = project.containsFileName(sourceFile.fileName)
    ? project.relativeFileName(sourceFile.fileName)
    : project.relativeFileName(requestedFileName)

  const visit = (node: Node): void => {
    const kindMatches =
      syntaxKind === undefined ||
      (Array.isArray(syntaxKind) ? syntaxKind.includes(node.kind) : node.kind === syntaxKind)
    if (kindMatches && guard(node)) {
      selections.push({
        value: node,
        project,
        fileName,
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        evidence: [
          {
            criterion: "syntax-kind",
            facts: { kind: SyntaxKind[node.kind] ?? node.kind },
          },
        ],
      })
    }
    node.forEachChild((child) => {
      visit(child)
      return undefined
    })
  }

  visit(sourceFile)
  return selections
}

/** All descendant nodes of the given kind, in every file the project checks. */
export const nodes = <A extends Node>(
  target: ProjectScope,
  guard: (node: Node) => node is A,
  syntaxKind?: SyntaxKindFilter,
): Query<A, ProjectSnapshotError> =>
  resolveScope(target).pipe(
    Stream.flatMap(({ project, fileName }) =>
      Stream.fromEffect(
        project.unsafeNative((nativeProject) =>
          nativeRequest("getSourceFile", () => nativeProject.program.getSourceFile(fileName)),
        ),
      ).pipe(
        Stream.flatMap((sourceFile) =>
          sourceFile === undefined
            ? Stream.empty
            : Stream.fromIterable(collectNodes(project, sourceFile, fileName, guard, syntaxKind)),
        ),
      ),
    ),
  )

export const calls = (target: ProjectScope): Query<CallExpression, ProjectSnapshotError> =>
  nodes(target, isCallExpression, SyntaxKind.CallExpression)

export const imports = (target: ProjectScope): Query<ImportDeclaration, ProjectSnapshotError> =>
  nodes(target, isImportDeclaration, SyntaxKind.ImportDeclaration)

export const identifiers = (target: ProjectScope): Query<Identifier, ProjectSnapshotError> =>
  nodes(target, isIdentifier, SyntaxKind.Identifier)

export const propertyAccesses = (
  target: ProjectScope,
): Query<PropertyAccessExpression, ProjectSnapshotError> =>
  nodes(target, isPropertyAccessExpression, SyntaxKind.PropertyAccessExpression)

/** Structural pattern matching query. */
export const match = <Out>(
  target: ProjectScope,
  pattern: Pattern<Node, Out>,
): Query<Out, ProjectSnapshotError> =>
  resolveScope(target).pipe(
    Stream.flatMap(({ project, fileName }) =>
      Stream.fromEffect(
        project.unsafeNative((nativeProject) =>
          nativeRequest("getSourceFile", () => nativeProject.program.getSourceFile(fileName)),
        ),
      ).pipe(
        Stream.flatMap((sourceFile) => {
          if (sourceFile === undefined) return Stream.empty
          const relFileName = project.containsFileName(sourceFile.fileName)
            ? project.relativeFileName(sourceFile.fileName)
            : project.relativeFileName(fileName)
          const candidateNodes: Array<Node> = []
          const visit = (node: Node) => {
            const kindMatches =
              pattern.syntaxKind === undefined ||
              (Array.isArray(pattern.syntaxKind)
                ? pattern.syntaxKind.includes(node.kind)
                : node.kind === pattern.syntaxKind)
            if (kindMatches) candidateNodes.push(node)
            node.forEachChild((child) => {
              visit(child)
              return undefined
            })
          }
          visit(sourceFile)

          return Stream.fromIterable(candidateNodes).pipe(
            Stream.mapEffect((node) =>
              pattern.match(node, project).pipe(
                Effect.map((result): Selection<Out> | undefined => {
                  if (!result.matched) return undefined
                  return {
                    value: result.value,
                    project,
                    fileName: relFileName,
                    start: node.getStart(sourceFile),
                    end: node.getEnd(),
                    evidence: [
                      {
                        criterion: pattern.kind ?? "pattern-match",
                        facts:
                          result.facts === undefined
                            ? { kind: SyntaxKind[node.kind] ?? node.kind }
                            : { kind: SyntaxKind[node.kind] ?? node.kind, ...result.facts },
                      },
                    ],
                  }
                }),
              ),
            ),
            Stream.filter((selection): selection is Selection<Out> => selection !== undefined),
          )
        }),
      ),
    ),
  )
