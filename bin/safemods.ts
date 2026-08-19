#!/usr/bin/env node
import { runCli } from "../src/Cli/Run.ts"
import { CliMatchFoundError } from "../src/Cli/Audit.ts"
import { Effect, Predicate, Schema } from "effect"

const args = process.argv.slice(2)

interface ErrorRecord {
  readonly _tag?: unknown
  readonly message?: unknown
}

const isErrorRecord = (cause: unknown): cause is ErrorRecord => Predicate.isObject(cause)

const printHelp = () => {
  console.log(`
safemods — Effect-native TypeScript 7 Project Transformation Engine

Usage:
  safemods scan <recipe.ts> [options]
  safemods run <recipe.ts> [options]
  safemods tool <recipe.ts>
  safemods <recipe.ts> [options]       Compatibility form for run

Options:
  --preview          Accepted compatibility no-op (run already defaults to preview)
  --verify           Run full snapshot verification and diagnostic delta analysis
  --apply            Apply verified changes atomically to disk
  --json             Output structured JSON report (for scan)
  --csv              Output CSV report (for scan)
  --format <fmt>     Output format: text, json, csv (for scan)
  --fail-on-match    Exit with non-zero code if any matches are found (for scan)
  --input <json|text>  JSON when valid; otherwise the raw string. Hyphenated values: --input=-1
  --cwd <path>       Target workspace working directory (defaults to current dir)
  --no-color         Disable ANSI terminal colors
  --scan             Compatibility alias for the scan command
  --tool-schema      Compatibility alias for the tool command
  --help, -h         Show help message
`)
}

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  printHelp()
  process.exit(0)
}

const commands = new Set(["scan", "run", "tool"])
const optionsWithValues = new Set(["--input", "--cwd", "--format"])
const knownFlags = new Set([
  "--preview",
  "--verify",
  "--apply",
  "--json",
  "--csv",
  "--fail-on-match",
  "--no-color",
  "--help",
  "-h",
  "--tool-schema",
  "--scan",
])

function failArg(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}

let command: string | undefined = undefined
let recipeArg: string | undefined = undefined
const flags = new Set<string>()
const optionsMap: Record<string, string> = {}

let i = 0
while (i < args.length) {
  const arg = args[i]
  if (arg === undefined) break
  const optionWithInlineValue = [...optionsWithValues].find((option) =>
    arg.startsWith(`${option}=`),
  )
  if (optionWithInlineValue !== undefined) {
    const value = arg.slice(optionWithInlineValue.length + 1)
    if (value === "") {
      failArg(`Missing value for ${optionWithInlineValue}`)
    }
    optionsMap[optionWithInlineValue] = value
    i++
    continue
  }
  if (optionsWithValues.has(arg)) {
    const value = args[i + 1]
    if (value === undefined || knownFlags.has(value) || commands.has(value)) {
      failArg(`Missing value for ${arg}`)
    }
    optionsMap[arg] = value
    i += 2
    continue
  }
  if (arg.startsWith("-")) {
    if (!knownFlags.has(arg)) {
      failArg(`Unknown flag ${arg}`)
    }
    flags.add(arg)
    i++
    continue
  }
  if (command === undefined && recipeArg === undefined && commands.has(arg)) {
    command = arg
    i++
    continue
  }
  if (recipeArg === undefined) {
    recipeArg = arg
    i++
    continue
  }
  failArg(`Unexpected positional argument ${arg}`)
}

if (!recipeArg) {
  console.error("Error: Missing recipe file path.")
  printHelp()
  process.exit(1)
}

const isTool = command === "tool" || flags.has("--tool-schema")
const isScan = command === "scan" || flags.has("--scan")
const isApply = flags.has("--apply")
const isVerify = flags.has("--verify") || isApply
const noColor = flags.has("--no-color")
const failOnMatch = flags.has("--fail-on-match")

const formatOption = optionsMap["--format"]
if (
  formatOption !== undefined &&
  formatOption !== "text" &&
  formatOption !== "json" &&
  formatOption !== "csv"
) {
  failArg(`Invalid format ${formatOption}`)
}

let format: "text" | "json" | "csv" = "text"
if (formatOption === "json" || flags.has("--json")) {
  format = "json"
} else if (formatOption === "csv" || flags.has("--csv")) {
  format = "csv"
}

const JsonValue = Schema.fromJsonString(Schema.Unknown)

let input: unknown = undefined
if (optionsMap["--input"] !== undefined) {
  const raw = optionsMap["--input"]
  const decoded = Schema.decodeExit(JsonValue)(raw)
  input = decoded._tag === "Success" ? decoded.value : raw
}

const cwd = optionsMap["--cwd"]

const mode: "preview" | "verify" | "apply" | "scan" = isScan
  ? "scan"
  : isApply
    ? "apply"
    : isVerify
      ? "verify"
      : "preview"

Effect.runPromise(
  runCli({
    recipePath: recipeArg,
    input,
    cwd,
    mode,
    format,
    failOnMatch,
    toolSchema: isTool,
    noColor,
  }),
).catch((cause: unknown) => {
  if (cause instanceof CliMatchFoundError) {
    process.exit(1)
  }
  const error = isErrorRecord(cause) ? cause : undefined
  const msg = Predicate.isString(error?.message) ? error.message : String(cause)
  console.error(`\n✖ ${msg}`)
  process.exit(1)
})
