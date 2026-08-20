/** Public Workspace values, errors, and snapshot contracts. */
import { Data, Predicate, type Effect, type Option } from "effect"
import type { Node, SourceFile } from "typescript/unstable/ast"
import type {
  Project as NativeProject,
  Symbol as NativeSymbol,
  Type as NativeType,
} from "typescript/unstable/async"
import type { NativeCompilerError } from "../Compiler/Service.ts"
import type { InvalidProjectRelativePath, ProjectRelativePath } from "../ProjectPath/index.ts"

const ConfiguredProjectTypeId: unique symbol = Symbol.for("@safemods/ConfiguredProject")

/** A stable project identity within a Workspace. */
export interface ConfiguredProject {
  readonly [ConfiguredProjectTypeId]: typeof ConfiguredProjectTypeId
  readonly id: string
  readonly config: string
}

export const ConfiguredProject = {
  make: (options: { readonly id: string; readonly config: string }): ConfiguredProject => {
    const project: ConfiguredProject = {
      [ConfiguredProjectTypeId]: ConfiguredProjectTypeId,
      id: options.id,
      config: options.config,
    }
    return Object.freeze(project)
  },
}

export interface WorkspaceDefinition {
  readonly projects: readonly [ConfiguredProject, ...ReadonlyArray<ConfiguredProject>]
}

export type WorkspaceChanges =
  | { readonly invalidateAll: true }
  | {
      readonly changed?: ReadonlyArray<string>
      readonly created?: ReadonlyArray<string>
      readonly deleted?: ReadonlyArray<string>
    }

export interface SnapshotTransition {
  readonly changes?: WorkspaceChanges
}

export class DuplicateConfiguredProject extends Data.TaggedError("DuplicateConfiguredProject")<{
  readonly id: string
  readonly configFileName: string
}> {}

export class ProjectNotInSnapshot extends Data.TaggedError("ProjectNotInSnapshot")<{
  readonly projectId: string
  readonly generation: number
}> {}

export class SnapshotExpired extends Data.TaggedError("SnapshotExpired")<{
  readonly generation: number
}> {}

export class SymbolNotFound extends Data.TaggedError("SymbolNotFound")<{
  readonly name: string
  readonly fileName: string
}> {}

export class FileNotFound extends Data.TaggedError("FileNotFound")<{
  readonly fileName: string
  readonly projectId: string
}> {}

export type ProjectSnapshotError = NativeCompilerError | SnapshotExpired

export const ProjectFileTypeSymbol = Symbol.for("@safemods/ProjectFile")

export interface DependencyGraphOptions {
  /** Recursively traverse indirect file references. Defaults to `false`. */
  readonly transitive?: boolean
}

/** A validated reference to an existing source file in a Project Snapshot. */
export interface ProjectFile {
  readonly [ProjectFileTypeSymbol]: true
  readonly project: ProjectSnapshot
  /** Canonical portable path for this checked project file. */
  readonly path: ProjectRelativePath
  readonly sourceFile: Effect.Effect<SourceFile, FileNotFound | ProjectSnapshotError>
  readonly sourceText: Effect.Effect<string, FileNotFound | ProjectSnapshotError>
  readonly symbolNamed: (
    name: string,
  ) => Effect.Effect<NativeSymbol, SymbolNotFound | ProjectSnapshotError>
  readonly findSymbolNamed: (
    name: string,
  ) => Effect.Effect<Option.Option<NativeSymbol>, ProjectSnapshotError>
  readonly symbolAt: (
    position: number,
  ) => Effect.Effect<NativeSymbol | undefined, ProjectSnapshotError>
  readonly typeAt: (position: number) => Effect.Effect<NativeType | undefined, ProjectSnapshotError>
  readonly referencingFiles: (
    options?: DependencyGraphOptions,
  ) => Effect.Effect<ReadonlyArray<ProjectFile>, ProjectSnapshotError>
  readonly referencedFiles: (
    options?: DependencyGraphOptions,
  ) => Effect.Effect<ReadonlyArray<ProjectFile>, ProjectSnapshotError>
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Type guard boundary for ProjectFile handles.
export const isProjectFile = (value: unknown): value is ProjectFile =>
  Predicate.isObject(value) && ProjectFileTypeSymbol in value

/** A checked view of one configured project in one Workspace Snapshot. */
export interface ProjectSnapshot {
  readonly project: ConfiguredProject
  /** Absolute directory containing the project configuration. */
  readonly root: string
  /** True when an absolute file name is a descendant of this project root. */
  readonly containsFileName: (fileName: string) => boolean
  /** Resolve a project-relative file name against this project root. */
  readonly resolveFileName: (fileName: string) => string
  /** Convert an absolute file name to slash-separated relative form. External paths can escape. */
  readonly relativeFileName: (fileName: string) => string
  readonly rootFiles: ReadonlyArray<string>
  readonly sourceFileNames: Effect.Effect<ReadonlyArray<string>, ProjectSnapshotError>
  readonly sourceFile: (
    fileName: string,
  ) => Effect.Effect<SourceFile | undefined, ProjectSnapshotError>
  readonly sourceText: (
    fileName: string,
  ) => Effect.Effect<string, FileNotFound | ProjectSnapshotError>
  readonly file: (
    fileName: string,
  ) => Effect.Effect<ProjectFile, FileNotFound | InvalidProjectRelativePath | ProjectSnapshotError>
  readonly findFile: (
    fileName: string,
  ) => Effect.Effect<Option.Option<ProjectFile>, InvalidProjectRelativePath | ProjectSnapshotError>
  readonly files: Effect.Effect<ReadonlyArray<ProjectFile>, ProjectSnapshotError>
  readonly semanticDiagnosticCount: Effect.Effect<number, ProjectSnapshotError>
  readonly symbolAt: (
    fileName: string,
    position: number,
  ) => Effect.Effect<NativeSymbol | undefined, ProjectSnapshotError>
  readonly symbolsAt: (
    fileName: string,
    positions: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyArray<NativeSymbol | undefined>, ProjectSnapshotError>
  readonly canonicalSymbol: (
    symbol: NativeSymbol,
  ) => Effect.Effect<NativeSymbol, ProjectSnapshotError>
  readonly symbolNamed: (
    name: string,
    options: { readonly within: string },
  ) => Effect.Effect<NativeSymbol, SymbolNotFound | ProjectSnapshotError>
  readonly findSymbolNamed: (
    name: string,
    options: { readonly within: string },
  ) => Effect.Effect<Option.Option<NativeSymbol>, ProjectSnapshotError>
  readonly typeAt: (
    fileName: string,
    position: number,
  ) => Effect.Effect<NativeType | undefined, ProjectSnapshotError>
  readonly typeToString: (type: NativeType) => Effect.Effect<string, ProjectSnapshotError>
  readonly isTypeAssignableTo: (
    fromType: NativeType,
    toType: NativeType,
  ) => Effect.Effect<boolean, ProjectSnapshotError>
  readonly intrinsicType: (
    kind: "string" | "number" | "boolean" | "any" | "unknown" | "never" | "void",
  ) => Effect.Effect<NativeType, ProjectSnapshotError>
  /** Print an AST node using the snapshot emitter. */
  readonly printNode: (node: Node) => Effect.Effect<string, ProjectSnapshotError>
  /** Native values remain valid only during the snapshot region. */
  readonly unsafeNative: <A, E, R>(
    use: (project: NativeProject) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SnapshotExpired, R>
}
