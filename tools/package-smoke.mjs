import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const fixture = await mkdtemp(join(tmpdir(), "safemods-package-smoke-"))

try {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  const pack = await exec("pnpm", ["pack", "--pack-destination", fixture], { cwd: root })
  const tarballPath = pack.stdout.trim().split("\n").at(-1)
  if (tarballPath === undefined || !tarballPath.endsWith(".tgz")) {
    throw new Error(`Could not determine packed tarball from pnpm output: ${pack.stdout}`)
  }
  const tarballName = basename(tarballPath)

  const imports = Object.keys(packageJson.exports)
    .map((subpath, index) => {
      const specifier =
        subpath === "." ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`
      return `import * as entry${index} from ${JSON.stringify(specifier)}\nvoid entry${index}`
    })
    .join("\n")

  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          [packageJson.name]: `file:./${tarballName}`,
          effect: packageJson.dependencies.effect,
          typescript: packageJson.dependencies.typescript,
        },
        devDependencies: {
          "@types/node": packageJson.devDependencies["@types/node"],
        },
      },
      null,
      2,
    ),
  )
  await writeFile(
    join(fixture, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2024",
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          types: ["node"],
          skipLibCheck: false,
        },
        include: ["smoke.ts"],
      },
      null,
      2,
    ),
  )
  await writeFile(join(fixture, "smoke.ts"), `${imports}\n`)
  await writeFile(
    join(fixture, "compatibility-smoke.mjs"),
    `
import * as Root from "safemods"

const forbidden = [
  [Root.Application, "Application"],
  [Root.Draft, "Draft"],
  [Root.Draft, "arguments"],
  [Root.Overlay, "overlay"],
  [Root.Overlay, "computeOverlayMap"],
  [Root.Plan, "parse"],
  [Root.Plan, "serialize"],
  [Root.Policy, "Policy"],
  [Root.Precondition, "Precondition"],
  [Root.Verification, "Preview"],
  [Root.Query, "Query"],
  [Root.Query, "preceding"],
  [Root.Query, "following"],
  [Root.Recipe, "Recipe"],
  [Root.Verification, "Verification"],
]

for (const [domain, name] of forbidden) {
  if (name in domain) throw new Error(\`Legacy export still present: \${name}\`)
}
`,
  )

  await exec("pnpm", ["install", "--ignore-scripts", "--frozen-lockfile=false"], { cwd: fixture })
  await exec("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], { cwd: fixture })
  await exec("node", ["compatibility-smoke.mjs"], { cwd: fixture })
} finally {
  await rm(fixture, { recursive: true, force: true })
}
