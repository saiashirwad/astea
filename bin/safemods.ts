#!/usr/bin/env node
import { runCli } from "../src/Cli/Run.ts"
import { Effect } from "effect"

const args = process.argv.slice(2)

const isErrorRecord = (
  value: unknown,
): value is { readonly _tag?: unknown; readonly message?: unknown } =>
  value !== null && typeof value === "object"

const printHelp = () => {
  console.log(`
safemods — Effect-native TypeScript 7 Project Transformation Engine

Usage:
  safemods scan <recipe.ts> [options]
  safemods run <recipe.ts> [options]
  safemods tool <recipe.ts>

Options:
  --preview          Generate transformation preview without modifying disk (default for run)
  --verify           Run full snapshot verification and diagnostic delta analysis
  --apply            Apply verified changes atomically to disk
  --json             Output structured JSON report (for scan)
  --csv              Output CSV report (for scan)
  --format <fmt>     Output format: text, json, csv (for scan)
  --fail-on-match    Exit with non-zero code if any matches are found (for scan)
  --input <json>     JSON string input for recipes with schemas
  --cwd <path>       Target workspace working directory (defaults to current dir)
  --no-color         Disable ANSI terminal colors
  --help, -h         Show help message
`)
}

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  printHelp()
  process.exit(0)
}

const commands = new Set(["scan", "run", "tool"])
const optionsWithValues = new Set(["--input", "--cwd", "--format"])

let command: string | undefined = undefined
let recipeArg: string | undefined = undefined
const flags = new Set<string>()
const optionsMap: Record<string, string> = {}

let i = 0
while (i < args.length) {
  const arg = args[i]
  if (arg === undefined) break
  if (optionsWithValues.has(arg)) {
    if (i + 1 < args.length) {
      optionsMap[arg] = args[i + 1]!
      i += 2
      continue
    }
  }
  if (arg.startsWith("-")) {
    flags.add(arg)
    i++
    continue
  }
  if (command === undefined && commands.has(arg)) {
    command = arg
    i++
    continue
  }
  if (recipeArg === undefined) {
    recipeArg = arg
    i++
    continue
  }
  i++
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

let format: "text" | "json" | "csv" = "text"
if (optionsMap["--format"] === "json" || flags.has("--json")) {
  format = "json"
} else if (optionsMap["--format"] === "csv" || flags.has("--csv")) {
  format = "csv"
}

let input: unknown = undefined
if (optionsMap["--input"]) {
  try {
    input = JSON.parse(optionsMap["--input"])
  } catch {
    input = optionsMap["--input"]
  }
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
  const error = isErrorRecord(cause) ? cause : undefined
  if (error?._tag === "CliMatchFoundError") {
    process.exit(1)
  }
  const msg = typeof error?.message === "string" ? error.message : String(cause)
  console.error(`\n✖ ${msg}`)
  process.exit(1)
})
