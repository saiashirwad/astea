import { other, target as renamed } from "./library.js"

const local = {
  target: (value: number) => value,
}

// This comment and the unusual spacing are source-fidelity sentinels.
export const first  = renamed(/* keep this comment */ 1)
export const excludedBySymbol = other(2)
export const excludedByText = local.target(3)
