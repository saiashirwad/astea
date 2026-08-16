/** Public Query and Criterion namespaces. Implementations live in focused modules. */
import { CriterionBase } from "./Model.ts"
import { RelationCriterion } from "./Relations.ts"
import * as Sources from "./Sources.ts"
import * as Operators from "./Operators.ts"
import * as Relations from "./Relations.ts"
import * as Semantic from "./Semantic.ts"

export * from "./Model.ts"
export * from "./Sources.ts"
export * from "./Operators.ts"
export * from "./Relations.ts"
export * from "./Semantic.ts"

export const Criterion = { ...CriterionBase, ...RelationCriterion }
export const Query = {
  nodes: Sources.nodes, calls: Sources.calls, imports: Sources.imports,
  identifiers: Sources.identifiers, propertyAccesses: Sources.propertyAccesses,
  referencesTo: Semantic.referencesTo, typeOf: Semantic.typeOf,
  typeAssignableTo: Semantic.typeAssignableTo, typeSatisfies: Semantic.typeSatisfies,
  match: Sources.match, where: Operators.where, within: Operators.within,
  withArgCount: Operators.withArgCount, inside: Relations.inside, has: Relations.has,
  precedes: Relations.precedes, preceding: Relations.preceding,
  follows: Relations.follows, following: Relations.following,
  resolvesTo: Semantic.resolvesTo, hasJSDocTag: Semantic.hasJSDocTag,
  isExported: Semantic.isExported, textMatches: Operators.textMatches,
  filter: Operators.filter, collect: Operators.collect,
}
