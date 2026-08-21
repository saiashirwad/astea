/** Public Query API and Criterion namespace. Implementations live in focused modules. */
import { CriterionBase } from "./Query.ts"
import { RelationCriterion } from "./Relations.ts"

export * from "./Query.ts"
export * from "./Sources.ts"
export * from "./Operators.ts"
export * from "./Relations.ts"
export * from "./Semantic.ts"

export const Criterion = { ...CriterionBase, ...RelationCriterion }
