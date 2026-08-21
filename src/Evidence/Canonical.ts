/** Canonical JSON text for durable evidence and plan values. */
import { Predicate } from "effect"
import type { Json } from "./Evidence.ts"

const canonicalize = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

/** Serialize JSON with object keys in recursive lexical order. */
export const canonicalJson = (value: Json): string => JSON.stringify(canonicalize(value))
