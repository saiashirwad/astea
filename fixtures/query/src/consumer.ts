import { other, target as renamed } from "./library.js"

const local = {
  target: (value: number) => value,
}

export const first = renamed(1)
export const excludedBySymbol = other(2)
export const excludedByText = local.target(3)
