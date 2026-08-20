/** Project-scoped compiler operations for one active snapshot region. */
import { path as Path } from "../platform/node.ts"
import { Effect, Option } from "effect"
import type { Node, SourceFile } from "typescript/unstable/ast"
import { isIdentifier } from "typescript/unstable/ast/is"
import {
  SymbolFlags,
  type Project as NativeProject,
  type Symbol as NativeSymbol,
  type Type as NativeType,
} from "typescript/unstable/async"
import { nativeRequest } from "../Compiler/Service.ts"
import {
  isWithinProject,
  projectRelativePath,
  resolveContainedSnapshotPath,
  resolveProjectRelativeFile,
} from "../Node/ProjectPath.ts"
import { InvalidProjectRelativePath } from "../ProjectPath/index.ts"
import {
  FileNotFound,
  type ConfiguredProject,
  type ProjectFile,
  ProjectFileTypeSymbol,
  type ProjectSnapshot,
  type SnapshotExpired,
  SymbolNotFound,
} from "./Model.ts"
import { dependencyGraphNavigation } from "./internal/DependencyGraph.ts"

export interface ProjectSnapshotOptions {
  readonly configured: ConfiguredProject
  readonly nativeProject: NativeProject
  readonly projectRoot: string
  readonly ensureActive: Effect.Effect<void, SnapshotExpired>
}

/** Build the checked project view for one native compiler project. */
export const projectSnapshotFor = ({
  configured,
  nativeProject,
  projectRoot,
  ensureActive,
}: ProjectSnapshotOptions): ProjectSnapshot => {
  const containsFileName = (fileName: string): boolean => isWithinProject(projectRoot, fileName)
  const resolveFileName = (fileName: string): string => Path.resolve(projectRoot, fileName)
  const relativeFileName = (fileName: string): string => projectRelativePath(projectRoot, fileName)

  const requireContainedPath = (fileName: string): string | undefined =>
    resolveContainedSnapshotPath(projectRoot, fileName)

  const isOwnedSourceFile = (sf: SourceFile, observedName = sf.fileName) =>
    Effect.gen(function* () {
      if (!isWithinProject(projectRoot, observedName)) return false
      const isDefault = yield* nativeRequest("isSourceFileDefaultLibrary", () =>
        nativeProject.program.isSourceFileDefaultLibrary(sf),
      )
      const isExternal = yield* nativeRequest("isSourceFileFromExternalLibrary", () =>
        nativeProject.program.isSourceFileFromExternalLibrary(sf),
      )
      return !isDefault && !isExternal
    })

  const ownedSourceFiles = Effect.gen(function* () {
    const allFileNames = yield* nativeRequest("getSourceFileNames", () =>
      nativeProject.program.getSourceFileNames(),
    )
    const owned: Array<{ relative: string; sourceFile: SourceFile }> = []
    for (const fileName of allFileNames) {
      if (!isWithinProject(projectRoot, fileName)) continue
      const sourceFile = yield* nativeRequest("getSourceFile", () =>
        nativeProject.program.getSourceFile(fileName),
      )
      if (sourceFile === undefined) continue
      if (!(yield* isOwnedSourceFile(sourceFile, fileName))) continue
      owned.push({
        relative: projectRelativePath(projectRoot, fileName),
        sourceFile,
      })
    }
    return owned
  })

  const sourceFileNames = Effect.gen(function* () {
    yield* ensureActive
    return (yield* ownedSourceFiles).map((file) => Path.resolve(projectRoot, file.relative))
  })

  const sourceFile = Effect.fn("ProjectSnapshot.sourceFile")(function* (fileName: string) {
    yield* ensureActive
    const absolute = requireContainedPath(fileName)
    if (absolute === undefined) return undefined
    const found = yield* nativeRequest("getSourceFile", () =>
      nativeProject.program.getSourceFile(absolute),
    )
    if (found === undefined || !(yield* isOwnedSourceFile(found, absolute))) return undefined
    return found
  })

  const sourceText = Effect.fn("ProjectSnapshot.sourceText")(function* (fileName: string) {
    yield* ensureActive
    const file = yield* sourceFile(fileName)
    if (file === undefined) {
      return yield* new FileNotFound({ fileName, projectId: configured.id })
    }
    return file.text
  })

  const semanticDiagnosticCount = Effect.gen(function* () {
    yield* ensureActive
    const diagnostics = yield* nativeRequest("getSemanticDiagnostics", () =>
      nativeProject.program.getSemanticDiagnostics(),
    )
    return diagnostics.length
  })

  const symbolAt = Effect.fn("ProjectSnapshot.symbolAt")(function* (
    fileName: string,
    position: number,
  ) {
    yield* ensureActive
    const absolute = requireContainedPath(fileName)
    if (absolute === undefined) return undefined
    return yield* nativeRequest("getSymbolAtPosition", () =>
      nativeProject.checker.getSymbolAtPosition(absolute, position),
    )
  })

  const canonicalSymbol = (symbol: NativeSymbol) =>
    (symbol.flags & SymbolFlags.Alias) === 0
      ? Effect.succeed(symbol)
      : nativeRequest("getAliasedSymbol", () => nativeProject.checker.getAliasedSymbol(symbol))

  const symbolNamed = Effect.fn("ProjectSnapshot.symbolNamed")(function* (
    name: string,
    options: { readonly within: string },
  ) {
    yield* ensureActive
    const absolute = requireContainedPath(options.within)
    if (absolute === undefined) {
      return yield* new SymbolNotFound({ name, fileName: options.within })
    }
    const source = yield* nativeRequest("getSourceFile", () =>
      nativeProject.program.getSourceFile(absolute),
    )
    if (source === undefined || !(yield* isOwnedSourceFile(source, absolute))) {
      return yield* new SymbolNotFound({ name, fileName: options.within })
    }
    const identifiers: Array<Node> = []
    const visit = (node: Node): void => {
      if (isIdentifier(node) && node.text === name) identifiers.push(node)
      node.forEachChild((child) => {
        visit(child)
        return undefined
      })
    }
    visit(source)
    if (identifiers.length === 0) {
      return yield* new SymbolNotFound({ name, fileName: options.within })
    }
    const symbols = yield* nativeRequest("getSymbolsAtLocations", () =>
      nativeProject.checker.getSymbolAtLocation(identifiers),
    )
    for (const symbol of symbols) {
      if (symbol === undefined) continue
      return yield* canonicalSymbol(symbol)
    }
    return yield* new SymbolNotFound({ name, fileName: options.within })
  })

  const findSymbolNamed = Effect.fn("ProjectSnapshot.findSymbolNamed")(function* (
    name: string,
    options: { readonly within: string },
  ) {
    return yield* symbolNamed(name, options).pipe(
      Effect.map(Option.some),
      Effect.catchTag("SymbolNotFound", () => Effect.succeed(Option.none())),
    )
  })

  const typeAt = Effect.fn("ProjectSnapshot.typeAt")(function* (
    fileName: string,
    position: number,
  ) {
    yield* ensureActive
    const absolute = requireContainedPath(fileName)
    if (absolute === undefined) return undefined
    const types = yield* nativeRequest("getTypeAtPosition", () =>
      nativeProject.checker.getTypeAtPosition(absolute, [position]),
    )
    return types[0]
  })

  const typeToString = Effect.fn("ProjectSnapshot.typeToString")(function* (type: NativeType) {
    yield* ensureActive
    return yield* nativeRequest("typeToString", () => nativeProject.checker.typeToString(type))
  })

  const isTypeAssignableTo = Effect.fn("ProjectSnapshot.isTypeAssignableTo")(function* (
    fromType: NativeType,
    toType: NativeType,
  ) {
    yield* ensureActive
    return yield* nativeRequest("isTypeAssignableTo", () =>
      nativeProject.checker.isTypeAssignableTo(fromType, toType),
    )
  })

  const intrinsicType = Effect.fn("ProjectSnapshot.intrinsicType")(function* (
    kind: "string" | "number" | "boolean" | "any" | "unknown" | "never" | "void",
  ) {
    yield* ensureActive
    return yield* nativeRequest("getIntrinsicType", () => {
      switch (kind) {
        case "string":
          return nativeProject.checker.getStringType()
        case "number":
          return nativeProject.checker.getNumberType()
        case "boolean":
          return nativeProject.checker.getBooleanType()
        case "any":
          return nativeProject.checker.getAnyType()
        case "unknown":
          return nativeProject.checker.getUnknownType()
        case "never":
          return nativeProject.checker.getNeverType()
        case "void":
          return nativeProject.checker.getVoidType()
      }
    })
  })

  const unsafeNative: ProjectSnapshot["unsafeNative"] = (use) =>
    Effect.andThen(
      ensureActive,
      Effect.suspend(() => use(nativeProject)),
    )

  const navigateDependencyGraph = dependencyGraphNavigation({
    nativeProject,
    projectRoot,
    ensureActive,
  })

  const makeProjectFile = (relativePath: string): ProjectFile => ({
    [ProjectFileTypeSymbol]: true,
    project: snapshotView,
    path: relativePath,
    sourceFile: snapshotView
      .sourceFile(relativePath)
      .pipe(
        Effect.flatMap((source) =>
          source !== undefined
            ? Effect.succeed(source)
            : Effect.fail(new FileNotFound({ projectId: configured.id, fileName: relativePath })),
        ),
      ),
    sourceText: snapshotView.sourceText(relativePath),
    symbolNamed: (name) => snapshotView.symbolNamed(name, { within: relativePath }),
    findSymbolNamed: (name) => snapshotView.findSymbolNamed(name, { within: relativePath }),
    symbolAt: (position) => snapshotView.symbolAt(relativePath, position),
    typeAt: (position) => snapshotView.typeAt(relativePath, position),
    referencingFiles: (options) =>
      navigateDependencyGraph(relativePath, "reverse", options?.transitive ?? false).pipe(
        Effect.map((paths) => paths.map(makeProjectFile)),
      ),
    referencedFiles: (options) =>
      navigateDependencyGraph(relativePath, "forward", options?.transitive ?? false).pipe(
        Effect.map((paths) => paths.map(makeProjectFile)),
      ),
  })

  const file = Effect.fn("ProjectSnapshot.file")(function* (fileName: string) {
    yield* ensureActive
    if (resolveProjectRelativeFile(projectRoot, fileName) === undefined) {
      return yield* new InvalidProjectRelativePath({ path: fileName })
    }
    const found = yield* sourceFile(fileName)
    if (found === undefined) {
      return yield* new FileNotFound({ projectId: configured.id, fileName })
    }
    return makeProjectFile(projectRelativePath(projectRoot, found.fileName))
  })

  const findFile = Effect.fn("ProjectSnapshot.findFile")(function* (fileName: string) {
    return yield* file(fileName).pipe(
      Effect.map(Option.some),
      Effect.catchTag("FileNotFound", () => Effect.succeed(Option.none())),
    )
  })

  const files: ProjectSnapshot["files"] = Effect.gen(function* () {
    yield* ensureActive
    return (yield* ownedSourceFiles).map((owned) => makeProjectFile(owned.relative))
  })

  const snapshotView: ProjectSnapshot = {
    project: configured,
    root: projectRoot,
    containsFileName,
    resolveFileName,
    relativeFileName,
    rootFiles: nativeProject.rootFiles,
    sourceFileNames,
    sourceFile,
    sourceText,
    file,
    findFile,
    files,
    semanticDiagnosticCount,
    symbolAt,
    symbolNamed,
    findSymbolNamed,
    typeAt,
    typeToString,
    isTypeAssignableTo,
    intrinsicType,
    unsafeNative,
  }

  return snapshotView
}
