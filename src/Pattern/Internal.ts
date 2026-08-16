import type { EvidenceFact } from "../Evidence/Model.ts"
import type { PatternMismatch, PatternResult } from "./Core.ts"

export const matchSuccess = <Out>(
  value: Out,
  facts?: Readonly<Record<string, EvidenceFact>>,
): PatternResult<Out> => facts === undefined
  ? { matched: true, value }
  : { matched: true, value, facts }

export const matchFailure: PatternMismatch = { matched: false }

export const matchesName = (name: string | RegExp, text: string): boolean =>
  typeof name === "string" ? text === name : name.test(text)
