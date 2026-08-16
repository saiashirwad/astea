#!/usr/bin/env node
import { runCli } from "../src/cli/index.ts"
import { Effect } from "effect"

const args = process.argv.slice(2)

const printHelp = () => {
  console.log(`
safemods — Effect-native TypeScript 7 Project Transformation Engine

Usage:
  safemods run <recipe.ts> [options]
  safemods tool <recipe.ts>

Options:
  --preview          Generate transformation preview without modifying disk (default)
  --verify           Run full snapshot verification and diagnostic delta analysis
  --apply            Apply verified changes atomically to disk
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

const command = args[0]
const recipeArg = args.find((a) => !a.startsWith("-") && a !== command)

if (!recipeArg) {
  console.error("Error: Missing recipe file path.")
  printHelp()
  process.exit(1)
}

const isApply = args.includes("--apply")
const isVerify = args.includes("--verify") || isApply
const isTool = command === "tool" || args.includes("--tool-schema")
const noColor = args.includes("--no-color")

const inputFlagIndex = args.indexOf("--input")
let input: unknown = undefined
if (inputFlagIndex !== -1 && args[inputFlagIndex + 1]) {
  try {
    input = JSON.parse(args[inputFlagIndex + 1]!)
  } catch {
    input = args[inputFlagIndex + 1]
  }
}

const cwdFlagIndex = args.indexOf("--cwd")
const cwd = cwdFlagIndex !== -1 ? args[cwdFlagIndex + 1] : undefined

Effect.runPromise(
  runCli({
    recipePath: recipeArg,
    input,
    cwd,
    mode: isApply ? "apply" : isVerify ? "verify" : "preview",
    toolSchema: isTool,
    noColor,
  }),
).catch((err) => {
  const msg = err && typeof err === "object" && "message" in err && typeof err.message === "string"
    ? err.message
    : String(err)
  console.error(`\n✖ ${msg}`)
  process.exit(1)
})
