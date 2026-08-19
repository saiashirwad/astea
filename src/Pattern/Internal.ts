import type { EvidenceFact } from "../Evidence/Core.ts"
import type { PatternMismatch, PatternResult } from "./Core.ts"
import { Predicate } from "effect"

export const matchSuccess = <Out>(
  value: Out,
  facts?: Readonly<Record<string, EvidenceFact>>,
): PatternResult<Out> =>
  facts === undefined ? { matched: true, value } : { matched: true, value, facts }

export const matchFailure: PatternMismatch = { matched: false }

export const matchesName = (name: string | RegExp, text: string): boolean => {
  if (Predicate.isString(name)) return text === name
  // `/g` and `/y` advance lastIndex; clone so two matches against the same
  // name do not alternate.
  const pattern = name.global || name.sticky ? new RegExp(name.source, name.flags) : name
  return pattern.test(text)
}
