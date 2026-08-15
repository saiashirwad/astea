/** PROTOTYPE — durable locators derived from snapshot-bound native values. */
import { createHash } from "node:crypto"
import * as Path from "node:path"
import { Data, Effect } from "effect"
import { type Node, SyntaxKind } from "typescript/unstable/ast"
import { isIdentifier } from "typescript/unstable/ast/is"
import { SymbolFlags, type Symbol as NativeSymbol } from "typescript/unstable/async"
import { nativeRequest, type NativeCompilerError } from "./native-compiler.ts"
import type { Selection } from "./semantic-query.ts"
import {
  type ProjectSnapshot,
  type ProjectSnapshotError,
  SnapshotExpired,
} from "./workspace-snapshot.ts"

export interface NodeAnchor {
  readonly projectConfigFileName: string
  readonly fileName: string
  readonly start: number
  readonly end: number
  readonly kind: SyntaxKind
  readonly textHash: string
}

export interface SymbolAnchor {
  readonly name: string
  readonly flags: number
  readonly declarations: ReadonlyArray<NodeAnchor>
}

export class AnchorMismatch extends Data.TaggedError("AnchorMismatch")<{
  readonly anchor: NodeAnchor
  readonly reason: "project" | "file" | "range" | "kind" | "text"
}> {}

const hash = (text: string): string => createHash("sha256").update(text).digest("hex")

const anchorNode = (
  project: ProjectSnapshot,
  node: Node,
): Effect.Effect<NodeAnchor, SnapshotExpired> => project.unsafeNative((nativeProject) => Effect.sync(() => {
  const sourceFile = node.getSourceFile()
  return {
    projectConfigFileName: project.project.configFileName,
    fileName: Path.relative(Path.dirname(String(nativeProject.id)), String(sourceFile.path)),
    start: node.getStart(sourceFile),
    end: node.getEnd(),
    kind: node.kind,
    textHash: hash(node.getText(sourceFile)),
  }
}))

export const anchorSelection = <A extends Node>(
  project: ProjectSnapshot,
  selection: Selection<A>,
): Effect.Effect<NodeAnchor, SnapshotExpired> => anchorNode(project, selection.value)

const findExactNode = (
  root: Node,
  anchor: NodeAnchor,
): Node | undefined => {
  let found: Node | undefined
  const visit = (node: Node): void => {
    if (found !== undefined) return
    if (node.getStart() === anchor.start && node.getEnd() === anchor.end) {
      found = node
      return
    }
    node.forEachChild((child) => {
      visit(child)
      return undefined
    })
  }
  visit(root)
  return found
}

export const resolveNodeAnchor = (
  project: ProjectSnapshot,
  anchor: NodeAnchor,
): Effect.Effect<Node, ProjectSnapshotError | AnchorMismatch> => Effect.gen(function*() {
  if (anchor.projectConfigFileName !== project.project.configFileName) {
    return yield* new AnchorMismatch({ anchor, reason: "project" })
  }

  return yield* project.unsafeNative((nativeProject) => Effect.gen(function*() {
    const fileName = Path.join(Path.dirname(String(nativeProject.id)), anchor.fileName)
    const sourceFile = yield* nativeRequest("resolve anchor source file", () =>
      nativeProject.program.getSourceFile(fileName))
    if (sourceFile === undefined) return yield* new AnchorMismatch({ anchor, reason: "file" })
    const node = findExactNode(sourceFile, anchor)
    if (node === undefined) return yield* new AnchorMismatch({ anchor, reason: "range" })
    if (node.kind !== anchor.kind) return yield* new AnchorMismatch({ anchor, reason: "kind" })
    if (hash(node.getText(sourceFile)) !== anchor.textHash) {
      return yield* new AnchorMismatch({ anchor, reason: "text" })
    }
    return node
  }))
})

export const anchorSymbol = (
  project: ProjectSnapshot,
  symbol: NativeSymbol,
): Effect.Effect<SymbolAnchor, NativeCompilerError | SnapshotExpired> => Effect.gen(function*() {
  const declarations = yield* Effect.all(symbol.declarations.map((handle) => project.unsafeNative(() =>
    nativeRequest("resolve symbol declaration", async () => {
      const node = await handle.resolve()
      if (node === undefined) throw new Error(`Could not resolve declaration for ${symbol.name}`)
      return node
    }))))
  const anchors = yield* Effect.all(declarations.map((node) => anchorNode(project, node)))
  return { name: symbol.name, flags: symbol.flags, declarations: anchors }
})

export const resolveSymbolAnchor = (
  project: ProjectSnapshot,
  anchor: SymbolAnchor,
): Effect.Effect<NativeSymbol, ProjectSnapshotError | AnchorMismatch> => Effect.gen(function*() {
  const declaration = anchor.declarations[0]
  if (declaration === undefined) {
    return yield* new AnchorMismatch({
      anchor: {
        projectConfigFileName: project.project.configFileName,
        fileName: "",
        start: 0,
        end: 0,
        kind: SyntaxKind.Unknown,
        textHash: hash(""),
      },
      reason: "range",
    })
  }
  const node = yield* resolveNodeAnchor(project, declaration)
  let symbolNameNode: Node | undefined
  const findName = (candidate: Node): void => {
    if (symbolNameNode !== undefined) return
    if (isIdentifier(candidate) && candidate.text === anchor.name) {
      symbolNameNode = candidate
      return
    }
    candidate.forEachChild((child) => {
      findName(child)
      return undefined
    })
  }
  findName(node)
  if (symbolNameNode === undefined) {
    return yield* new AnchorMismatch({ anchor: declaration, reason: "text" })
  }
  const nameNode: Node = symbolNameNode
  const symbol = yield* project.unsafeNative((nativeProject) => nativeRequest(
    "resolve anchored symbol",
    () => nativeProject.checker.getSymbolAtLocation(nameNode),
  ))
  if (symbol === undefined) return yield* new AnchorMismatch({ anchor: declaration, reason: "range" })
  const canonical = (symbol.flags & SymbolFlags.Alias) === 0
    ? symbol
    : yield* project.unsafeNative((nativeProject) => nativeRequest(
      "canonicalize anchored symbol",
      () => nativeProject.checker.getAliasedSymbol(symbol),
    ))
  if (canonical.name !== anchor.name) {
    return yield* new AnchorMismatch({ anchor: declaration, reason: "text" })
  }
  return canonical
})
