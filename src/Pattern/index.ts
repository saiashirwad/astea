import type { Node } from "typescript/unstable/ast"
import type { Pattern as CorePattern } from "./Core.ts"
export { any, bind, not, predicate, tuple } from "./Core.ts"
export type { AnyPattern, PatternMatchResult, PatternMismatch, PatternResult } from "./Core.ts"
export * from "./Expressions.ts"
export * from "./Declarations.ts"
export * from "./ControlFlow.ts"
export * from "./Semantic.ts"

import * as Core from "./Core.ts"
import * as Expressions from "./Expressions.ts"
import * as Declarations from "./Declarations.ts"
import * as ControlFlow from "./ControlFlow.ts"
import * as Semantic from "./Semantic.ts"

export interface Pattern<N extends Node = Node, Out = N> extends CorePattern<N, Out> {}

/** Namespace-style matcher API retained for compatibility. */
export const Pattern = {
  ...Core,
  ...Expressions,
  ...Declarations,
  ...ControlFlow,
  ...Semantic,
}
