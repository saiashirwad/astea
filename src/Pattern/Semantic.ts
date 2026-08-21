import { Effect, Predicate } from "effect"
import type { Node } from "typescript/unstable/ast"
import type { Type as NativeType } from "typescript/unstable/async"
import { matchFailure, matchSuccess, matchesName, type Pattern } from "./Pattern.ts"

export type IntrinsicTypeName =
  | "string"
  | "number"
  | "boolean"
  | "any"
  | "unknown"
  | "never"
  | "void"
const isIntrinsic = (value: NativeType | IntrinsicTypeName): value is IntrinsicTypeName =>
  Predicate.isString(value)
export const typed = (options?: {
  readonly assignableTo?: NativeType | IntrinsicTypeName
  readonly typeString?: string | RegExp
}): Pattern<Node, Node> => ({
  mode: "node",
  kind: "typed",
  match: (node, project) =>
    Effect.gen(function* () {
      const source = node.getSourceFile()
      const type = yield* project.typeAt(
        project.relativeFileName(source.fileName),
        node.getStart(source),
      )
      if (type === undefined) return matchFailure
      if (
        options?.typeString !== undefined &&
        !matchesName(options.typeString, yield* project.typeToString(type))
      )
        return matchFailure
      if (options?.assignableTo !== undefined) {
        const target = isIntrinsic(options.assignableTo)
          ? yield* project.intrinsicType(options.assignableTo)
          : options.assignableTo
        if (!(yield* project.isTypeAssignableTo(type, target))) return matchFailure
      }
      return matchSuccess(node, { type: yield* project.typeToString(type) })
    }),
})
