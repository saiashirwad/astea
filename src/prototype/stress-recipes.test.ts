import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  buildImportMigrationPlan,
  buildSymbolRenamePlan,
  importMigrationCandidates,
  symbolRenameCandidates,
} from "./stress-recipes.ts"
import {
  applicationLayer,
  PlanApplication,
  previewPlan,
  verifyPreview,
} from "./verification.ts"
import { ConfiguredProject, layer, Workspace, WorkspaceSnapshot } from "./workspace-snapshot.ts"

const fixtureSource = fileURLToPath(new URL("../../fixtures/stress/", import.meta.url))

const withFixture = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await Fs.mkdtemp("/tmp/teatime-stress-")
  await Fs.cp(fixtureSource, root, { recursive: true })
  try {
    return await use(root)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}

const overlayRead = (root: string, overlays: ReadonlyMap<string, string>) => (fileName: string) => {
  const exact = overlays.get(fileName)
  if (exact !== undefined) return exact
  for (const [plannedFileName, content] of overlays) {
    if (fileName.endsWith(Path.relative(root, plannedFileName))) return content
  }
  return undefined
}

describe("representative Transformation Recipes", () => {
  it("migrates an import with trivia, tolerates a baseline error, and rejects a later workspace change", () =>
    withFixture(async (root) => {
      const configured = ConfiguredProject.make(Path.join(root, "tsconfig.json"))
      const initial = await Effect.runPromise(Workspace.use((workspace) => workspace.withSnapshot(
        {},
        Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          const project = yield* snapshot.project(configured)
          return {
            built: yield* buildImportMigrationPlan(project, root, {
              from: "./legacy.js",
              to: "./replacement.js",
              expectedMatches: 1,
            }),
            errors: yield* project.semanticDiagnosticCount(),
          }
        }),
      )).pipe(Effect.provide(layer({ projects: [configured] }, { cwd: root }))))

      expect(initial.built.matchCount).toBe(1)
      expect(initial.errors).toBeGreaterThan(0)
      const preview = await Effect.runPromise(previewPlan(initial.built.plan, root))
      expect(preview.files[0]?.afterText).toContain(
        "import { /* preserve import trivia */ feature as importedFeature } from './replacement.js'",
      )

      const overlays = new Map(preview.files.map((file) => [Path.join(root, file.fileName), file.afterText]))
      const proposed = await Effect.runPromise(Workspace.use((workspace) => workspace.withSnapshot(
        {},
        Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          const project = yield* snapshot.project(configured)
          return {
            errors: yield* project.semanticDiagnosticCount(),
            secondMatches: (yield* importMigrationCandidates(project, "./legacy.js")).length,
          }
        }),
      )).pipe(Effect.provide(layer(
        { projects: [configured] },
        { cwd: root, fs: { readFile: overlayRead(root, overlays) } },
      ))))
      expect(proposed).toEqual({ errors: initial.errors, secondMatches: 0 })

      const verified = await Effect.runPromise(verifyPreview(initial.built.plan, preview, {
        actualMatches: initial.built.matchCount,
        baselineErrorCount: initial.errors,
        proposedErrorCount: proposed.errors,
        secondPlanEditCount: proposed.secondMatches,
      }))

      const unrelated = Path.join(root, "src/unrelated.ts")
      await Fs.appendFile(unrelated, "\n// concurrent workspace change\n")
      const applicationExit = await Effect.runPromiseExit(PlanApplication.use((application) =>
        application.apply(verified)).pipe(Effect.provide(applicationLayer(root))))
      expect(applicationExit._tag).toBe("Failure")
      if (applicationExit._tag === "Failure") {
        expect(String(applicationExit.cause)).toContain("StalePlanError")
      }
    }))

  it("renames one canonical symbol without touching aliases or same-text locals", () =>
    withFixture(async (root) => {
      const configured = ConfiguredProject.make(Path.join(root, "tsconfig.json"))
      const declarationFileName = Path.join(root, "src/symbol.ts")
      const initial = await Effect.runPromise(Workspace.use((workspace) => workspace.withSnapshot(
        {},
        Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          const project = yield* snapshot.project(configured)
          return {
            built: yield* buildSymbolRenamePlan(project, root, {
              declarationFileName,
              oldName: "oldName",
              newName: "newName",
              expectedMatches: 5,
            }),
            errors: yield* project.semanticDiagnosticCount(),
          }
        }),
      )).pipe(Effect.provide(layer({ projects: [configured] }, { cwd: root }))))
      expect(initial.built.matchCount).toBe(5)

      const preview = await Effect.runPromise(previewPlan(initial.built.plan, root))
      const previewByFile = new Map(preview.files.map((file) => [file.fileName, file.afterText]))
      expect(previewByFile.get("src/symbol.ts")).toContain("function newName")
      expect(previewByFile.get("src/symbol-direct.ts")).toContain("newName(1)")
      expect(previewByFile.get("src/symbol-aliased.ts")).toContain(
        "/* preserve alias trivia */ newName as localName",
      )
      expect(previewByFile.get("src/symbol-aliased.ts")).toContain("localName(2)")
      expect(previewByFile.get("src/symbol-barrel.ts")).toContain("newName as publicName")

      const overlays = new Map(preview.files.map((file) => [Path.join(root, file.fileName), file.afterText]))
      const proposed = await Effect.runPromise(Workspace.use((workspace) => workspace.withSnapshot(
        {},
        Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          const project = yield* snapshot.project(configured)
          return {
            errors: yield* project.semanticDiagnosticCount(),
            secondMatches: (yield* symbolRenameCandidates(project, declarationFileName, "oldName")).length,
          }
        }),
      )).pipe(Effect.provide(layer(
        { projects: [configured] },
        { cwd: root, fs: { readFile: overlayRead(root, overlays) } },
      ))))
      expect(proposed).toEqual({ errors: initial.errors, secondMatches: 0 })

      const verified = await Effect.runPromise(verifyPreview(initial.built.plan, preview, {
        actualMatches: initial.built.matchCount,
        baselineErrorCount: initial.errors,
        proposedErrorCount: proposed.errors,
        secondPlanEditCount: proposed.secondMatches,
      }))
      const receipt = await Effect.runPromise(PlanApplication.use((application) =>
        application.apply(verified)).pipe(Effect.provide(applicationLayer(root))))
      expect(receipt.outputs).toHaveLength(4)
      expect(await Fs.readFile(Path.join(root, "src/unrelated.ts"), "utf8")).toContain("oldName(4)")
      expect(await Fs.readFile(Path.join(root, "src/symbol-reexport-consumer.ts"), "utf8"))
        .toContain("publicName(3)")
    }))

  it("rejects a symbol rename when the destination declaration already exists", () =>
    withFixture(async (root) => {
      const declarationFileName = Path.join(root, "src/symbol.ts")
      await Fs.appendFile(declarationFileName, "\nexport function newName(value: number) { return value }\n")
      const configured = ConfiguredProject.make(Path.join(root, "tsconfig.json"))
      const exit = await Effect.runPromiseExit(Workspace.use((workspace) => workspace.withSnapshot(
        {},
        Effect.gen(function*() {
          const snapshot = yield* WorkspaceSnapshot
          const project = yield* snapshot.project(configured)
          return yield* buildSymbolRenamePlan(project, root, {
            declarationFileName,
            oldName: "oldName",
            newName: "newName",
            expectedMatches: 5,
          })
        }),
      )).pipe(Effect.provide(layer({ projects: [configured] }, { cwd: root }))))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("RenameConflict")
    }))
})
