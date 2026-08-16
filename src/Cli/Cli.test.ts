import { nodeFsPromises as Fs } from "../platform/node.ts"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, effect, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  buildAuditReport,
  CliMatchFoundError,
  computeLineAndColumn,
  ConfiguredProject,
  Draft,
  Query,
  Recipe,
  renderAuditCsv,
  renderAuditJson,
  renderAuditText,
  Workspace,
  WorkspaceSnapshot,
} from "../api/index.ts"
import { runCli } from "./Run.ts"

const execFileAsync = promisify(execFile)
const fixtureSource = fileURLToPath(new URL("../../fixtures/recipe/", import.meta.url))
const binPath = fileURLToPath(new URL("../../bin/safemods.ts", import.meta.url))
const wrapRecipePath = fileURLToPath(new URL("../api/wrap-target-input.ts", import.meta.url))

const withFixture = <A, E, R>(
  use: (root: string, app: ConfiguredProject) => Effect.Effect<A, E, R>,
): Effect.Effect<A, unknown, Exclude<R, Workspace>> =>
  Effect.acquireUseRelease(
    Effect.tryPromise(async () => {
      const root = await Fs.mkdtemp("/tmp/safemods-cli-")
      await Fs.cp(fixtureSource, root, { recursive: true })
      return root
    }),
    (root) => {
      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
      const workspaceLayer = Workspace.layer({ projects: [app] }, { cwd: root })
      return use(root, app).pipe(Effect.provide(workspaceLayer))
    },
    (root) => Effect.tryPromise(() => Fs.rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
  )

describe("safemods scan & audit reporting (@effect/vitest)", () => {
  it("computeLineAndColumn correctly resolves 1-based line and column from offset", () => {
    const text = "const a = 1\nconst b = 2\nconst c = 3"
    // line 1: const a = 1 (offset 0..11, \n at 11)
    expect(computeLineAndColumn(text, 0)).toEqual({ line: 1, column: 1 })
    expect(computeLineAndColumn(text, 6)).toEqual({ line: 1, column: 7 })
    // line 2: const b = 2 (offset 12..23, \n at 23)
    expect(computeLineAndColumn(text, 12)).toEqual({ line: 2, column: 1 })
    expect(computeLineAndColumn(text, 18)).toEqual({ line: 2, column: 7 })
    // line 3: const c = 3 (offset 24..)
    expect(computeLineAndColumn(text, 24)).toEqual({ line: 3, column: 1 })
    // Clamping boundary
    expect(computeLineAndColumn(text, 9999)).toEqual({ line: 3, column: 12 })
  })

  effect("Draft.audit produces read-only draft with evidence and matches count", () =>
    withFixture((_root, app) =>
      Effect.gen(function*() {
        const workspace = yield* Workspace
        yield* workspace.withSnapshot({}, Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          const project = yield* snapshot.project(app)
          const libraryFile = yield* project.file("src/library.ts")
          const targetSymbol = yield* libraryFile.symbolNamed("target")

          const selections = yield* Query.calls(project).pipe(
            Query.where(Query.resolvesTo(targetSymbol, { location: (c) => c.expression })),
            Query.collect,
          )

          expect(selections.length).toBeGreaterThan(0)
          const auditDraft = Draft.audit(selections)

          expect(auditDraft.edits).toEqual([])
          expect(auditDraft.matches).toBe(selections.length)
          expect(auditDraft.evidence.length).toBe(selections.length)
          expect(auditDraft.evidence[0]?.kind).toBe("selection")
          expect(auditDraft.evidence[0]?.facts.fileName).toBe("src/consumer.ts")
          expect(auditDraft.evidence[0]?.facts.projectId).toBe("app")
        }))
      })
    )
  )

  effect("buildAuditReport formats findings with source locations, lines, columns, snippets, and criteria", () =>
    withFixture((_root, app) =>
      Effect.gen(function*() {
        const auditRecipe = Recipe.define("audit-target-calls", {
          version: "1.0.0",
          run: () =>
            Effect.gen(function*() {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              const libraryFile = yield* project.file("src/library.ts")
              const targetSymbol = yield* libraryFile.symbolNamed("target")

              const calls = yield* Query.calls(project).pipe(
                Query.where(Query.resolvesTo(targetSymbol, { location: (c) => c.expression })),
                Query.collect,
              )
              return Draft.audit(calls)
            }),
        })

        const plan = yield* Recipe.run(auditRecipe, undefined)
        expect(plan.edits.length).toBe(0)
        expect(plan.measurements?.matches).toBeGreaterThan(0)

        const workspace = yield* Workspace
        const report = yield* workspace.withSnapshot({}, Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          return yield* buildAuditReport(plan, snapshot)
        }))

        expect(report.recipe.name).toBe("audit-target-calls")
        expect(report.recipe.version).toBe("1.0.0")
        expect(report.totalMatches).toBe(2)
        expect(report.totalFiles).toBe(2)
        expect(report.findings.length).toBe(report.totalMatches)

        const first = report.findings[0]!
        expect(first.projectId).toBe("app")
        expect(first.fileName).toBe("src/consumer.ts")
        expect(first.startLine).toBeGreaterThan(0)
        expect(first.startColumn).toBeGreaterThan(0)
        expect(first.endLine).toBeGreaterThanOrEqual(first.startLine)
        expect(first.snippet).toContain("renamed")

        // Check text format
        const textOutput = renderAuditText(report, { color: false })
        expect(textOutput).toContain("Audit Report: audit-target-calls [v1.0.0]")
        expect(textOutput).toContain("src/consumer.ts")
        expect(textOutput).toContain("line")

        // Check JSON format
        const jsonOutput = renderAuditJson(report)
        const parsedJson = JSON.parse(jsonOutput)
        expect(parsedJson.recipe.name).toBe("audit-target-calls")
        expect(parsedJson.findings.length).toBe(report.totalMatches)

        // Check CSV format
        const csvOutput = renderAuditCsv(report)
        expect(csvOutput).toContain("project,file,start_line,start_col,end_line,end_col,start_offset,end_offset,criteria,snippet")
        expect(csvOutput).toContain("app,src/consumer.ts")
      })
    )
  )

  effect("runCli mode=scan outputs JSON and CSV and respects failOnMatch", () =>
    withFixture((root, _app) =>
      Effect.gen(function*() {
        const input = {
          project: { id: "app", config: "tsconfig.json" },
          declarationFile: "src/library.ts",
          property: "wrapped",
        }

        // 1. Scan mode with text format
        yield* runCli({
          recipePath: wrapRecipePath,
          cwd: root,
          input,
          mode: "scan",
          format: "text",
          noColor: true,
        })

        // 2. Scan mode with JSON format
        yield* runCli({
          recipePath: wrapRecipePath,
          cwd: root,
          input,
          mode: "scan",
          format: "json",
          noColor: true,
        })

        // 3. Scan mode with CSV format
        yield* runCli({
          recipePath: wrapRecipePath,
          cwd: root,
          input,
          mode: "scan",
          format: "csv",
          noColor: true,
        })

        // 4. Scan mode with failOnMatch=true throws CliMatchFoundError when matches exist
        const result = yield* runCli({
          recipePath: wrapRecipePath,
          cwd: root,
          input,
          mode: "scan",
          failOnMatch: true,
          noColor: true,
        }).pipe(
          Effect.flip,
        )

        expect(result).toBeInstanceOf(CliMatchFoundError)
      })
    ),
    60_000,
  )

  effect("CLI executable bin/safemods.ts scan runs via subprocess", () =>
    withFixture((root, _app) =>
      Effect.gen(function*() {
        const inputJson = JSON.stringify({
          project: { id: "app", config: "tsconfig.json" },
          declarationFile: "src/library.ts",
          property: "wrapped",
        })

        // Execute scan command
        const { stdout: textOut } = yield* Effect.tryPromise(() =>
          execFileAsync("node", [binPath, "scan", wrapRecipePath, "--cwd", root, "--input", inputJson, "--no-color"])
        )
        expect(textOut).toContain("Audit Report: wrap-target-input [v1.0.0]")
        expect(textOut).toContain("src/consumer.ts")

        // Execute scan with --json
        const { stdout: jsonOut } = yield* Effect.tryPromise(() =>
          execFileAsync("node", [binPath, "scan", wrapRecipePath, "--cwd", root, "--input", inputJson, "--json"])
        )
        const parsed = JSON.parse(jsonOut)
        expect(parsed.recipe.name).toBe("wrap-target-input")
        expect(parsed.findings.length).toBeGreaterThan(0)

        // Execute scan with --csv
        const { stdout: csvOut } = yield* Effect.tryPromise(() =>
          execFileAsync("node", [binPath, "scan", wrapRecipePath, "--cwd", root, "--input", inputJson, "--csv"])
        )
        expect(csvOut).toContain("project,file,start_line,start_col,end_line,end_col,start_offset,end_offset,criteria,snippet")
        expect(csvOut).toContain("app,src/consumer.ts")

        // Execute scan with --fail-on-match asserting exit code 1
        const failOnMatchError = yield* Effect.tryPromise(() =>
          execFileAsync("node", [binPath, "scan", wrapRecipePath, "--cwd", root, "--input", inputJson, "--fail-on-match"])
        ).pipe(
          Effect.flip,
        )
        expect(failOnMatchError).toBeDefined()
      })
    ),
    60_000,
  )
})
