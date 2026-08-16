import { readdir, readFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"

const root = resolve(import.meta.dirname, "..")
const sourceRoot = resolve(root, "src")
const failures = []

const files = async (directory) => (await Promise.all((await readdir(directory, { withFileTypes: true })).map((entry) =>
  entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]
))).flat()

for (const file of await files(sourceRoot)) {
  if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
  const owner = relative(sourceRoot, file).split(sep)[0]
  const text = await readFile(file, "utf8")
  for (const match of text.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)) {
    const specifier = match[1]
    if (specifier === "safemods") {
      failures.push(`${relative(root, file)}: package self-import ${specifier}`)
    }
    if (!specifier.startsWith(".")) continue
    const target = resolve(dirname(file), specifier)
    if (target === resolve(sourceRoot, "index.ts")) {
      failures.push(`${relative(root, file)}: root self-import ${specifier}`)
    }
    const targetParts = relative(sourceRoot, target).split(sep)
    const targetOwner = targetParts[0]
    if (targetParts.includes("internal") && targetOwner !== owner) {
      failures.push(`${relative(root, file)}: imports private ${specifier}`)
    }
    if (owner === "Pattern" && targetOwner === "Query") {
      failures.push(`${relative(root, file)}: Pattern must not import Query`)
    }
    if (owner === "Workspace" && ["Draft", "Plan", "Overlay", "Preview", "Verification", "Application"].includes(targetOwner)) {
      failures.push(`${relative(root, file)}: Workspace imports higher layer ${targetOwner}`)
    }
    if (targetOwner === "Cli" && owner !== "Cli" && owner !== "AgentTool") {
      failures.push(`${relative(root, file)}: imports Cli outside an entry-point layer`)
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exitCode = 1
} else {
  console.log("Architecture boundaries passed")
}
