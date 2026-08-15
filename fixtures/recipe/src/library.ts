export interface TargetInput {
  readonly value: number
}

export function target(input: number | TargetInput): number {
  const value = typeof input === "number" ? input : input.value
  return value + 1
}

export function other(value: number): number {
  return value - 1
}
