import { nodeFsPromises as Fs, path as Path } from "../platform/node.ts"
import { fileURLToPath } from "node:url"
import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import { emptySnapshot } from "../VirtualFs/index.ts"
import {
  ConfiguredProject,
  InvalidProjectRelativePath,
  isWithinProject,
  projectRelativePath,
  Workspace,
  WorkspaceSnapshot,
} from "./index.ts"
import { workspaceLayerNode } from "../Node/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

const stressFixture = fileURLToPath(new URL("../../fixtures/stress/", import.meta.url))

const withCopiedFixture = <A, E, R>(
  fixturePath: string,
  use: (root: string, app: ConfiguredProject) => Effect.Effect<A, E, R>,
  options?: { readonly fs?: NonNullable<Parameters<typeof Workspace.layer>[1]>["fs"] },
): Effect.Effect<A, unknown, Exclude<R, Workspace>> =>
  Effect.acquireUseRelease(
    Effect.tryPromise(async () => {
      const root = await Fs.mkdtemp("/tmp/safemods-workspace-")
      await Fs.cp(fixturePath, root, { recursive: true })
      return root
    }),
    (root) => {
      const app = ConfiguredProject.make({ id: "app", config: "tsconfig.json" })
      return use(root, app).pipe(
        Effect.provide(
          workspaceLayerNode(
            { projects: [app] },
            options?.fs === undefined ? { cwd: root } : { cwd: root, fs: options.fs },
          ),
        ),
      )
    },
    (root) =>
      Effect.tryPromise(() => Fs.rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
  )

describe("workspace path confinement, overlay FS, and symbol lookup", () => {
  effect("rejects absolute and escaping project configs", () =>
    withFixture((root) =>
      Effect.gen(function* () {
        for (const config of [
          "../tsconfig.json",
          "/tmp/tsconfig.json",
          Path.resolve(root, "..", "tsconfig.json"),
        ]) {
          const escaped = ConfiguredProject.make({ id: "escaped", config })
          const failure = yield* Effect.void.pipe(
            Effect.provide(workspaceLayerNode({ projects: [escaped] }, { cwd: root })),
            Effect.flip,
          )
          expect(failure).toBeInstanceOf(InvalidProjectRelativePath)
        }
      }),
    ),
  )

  effect(
    "rejects absolute and escaping snapshot paths",
    () =>
      withFixture((_, app) =>
        Effect.gen(function* () {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot(
            {},
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              const library = Path.join(project.root, "src/library.ts")
              expect(project.resolveFileName("src/library.ts")).toBe(library)
              expect(project.relativeFileName(library)).toBe("src/library.ts")
              expect(project.containsFileName(library)).toBe(true)
              expect(project.containsFileName(Path.resolve(project.root, "../outside.ts"))).toBe(
                false,
              )
              const escaped = ["../secret.ts", "/tmp/secret.ts"]
              for (const path of escaped) {
                expect(yield* project.file(path).pipe(Effect.flip)).toBeInstanceOf(
                  InvalidProjectRelativePath,
                )
                expect(yield* project.sourceFile(path)).toBeUndefined()
                expect((yield* project.sourceText(path).pipe(Effect.flip))._tag).toBe(
                  "FileNotFound",
                )
                expect(
                  (yield* project.symbolNamed("target", { within: path }).pipe(Effect.flip))._tag,
                ).toBe("SymbolNotFound")
              }
            }),
          )
        }),
      ),
    60_000,
  )

  effect("keeps mixed-case siblings distinct in containment", () =>
    Effect.sync(() => {
      const projectRoot = "/tmp/SafeModsCase/Project"
      const inside = "/tmp/SafeModsCase/Project/src/index.ts"
      const mixedCaseSibling = "/tmp/SafeModsCase/project/src/index.ts"
      expect(isWithinProject(projectRoot, inside)).toBe(true)
      expect(isWithinProject(projectRoot, mixedCaseSibling)).toBe(false)
      expect(isWithinProject(projectRoot, "/tmp/SafeModsCase/Project/../Other/x.ts")).toBe(false)
      expect(projectRelativePath(projectRoot, mixedCaseSibling).startsWith("..")).toBe(true)
    }),
  )

  effect(
    "delegates isolated overlay reads to the caller filesystem",
    () => {
      const marker = "export const fromCallback = 1;\n"
      const recipeFixture = fileURLToPath(new URL("../../fixtures/recipe/", import.meta.url))
      return withCopiedFixture(
        recipeFixture,
        (root, app) =>
          Effect.gen(function* () {
            const disk = yield* Effect.tryPromise(() =>
              Fs.readFile(Path.join(root, "src/library.ts"), "utf8"),
            )
            const workspace = yield* Workspace
            yield* workspace.withIsolatedSnapshot(
              emptySnapshot(),
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const text = yield* project.sourceText("src/library.ts")
                expect(text).toBe(marker)
                expect(disk).not.toBe(marker)
              }),
            )
          }),
        {
          fs: {
            readFile: (fileName) => {
              const normalized = fileName.replaceAll("\\", "/")
              return normalized.endsWith("src/library.ts") ? marker : undefined
            },
            fileExists: (fileName) => {
              const normalized = fileName.replaceAll("\\", "/")
              return normalized.endsWith("src/library.ts") ? true : undefined
            },
          },
        },
      )
    },
    60_000,
  )

  effect(
    "resolves aliased and re-exported names with symbolNamed",
    () =>
      withCopiedFixture(stressFixture, (_, app) =>
        Effect.gen(function* () {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot(
            {},
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              const original = yield* project.symbolNamed("oldName", { within: "src/symbol.ts" })
              const aliased = yield* project.symbolNamed("localName", {
                within: "src/symbol-aliased.ts",
              })
              const reexported = yield* project.symbolNamed("publicName", {
                within: "src/symbol-barrel.ts",
              })
              const throughBarrel = yield* project.symbolNamed("publicName", {
                within: "src/symbol-reexport-consumer.ts",
              })
              expect(aliased).toBe(original)
              expect(reexported).toBe(original)
              expect(throughBarrel).toBe(original)
            }),
          )
        }),
      ),
    60_000,
  )

  effect(
    "resolves query-fixture aliases and re-exports with symbolNamed",
    () =>
      withFixture((_, app) =>
        Effect.gen(function* () {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot(
            {},
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              const original = yield* project.symbolNamed("target", { within: "src/library.ts" })
              const aliased = yield* project.symbolNamed("renamed", { within: "src/consumer.ts" })
              const reexported = yield* project.symbolNamed("publicTarget", {
                within: "src/barrel.ts",
              })
              const throughBarrel = yield* project.symbolNamed("publicTarget", {
                within: "src/reexport-consumer.ts",
              })
              expect(aliased).toBe(original)
              expect(reexported).toBe(original)
              expect(throughBarrel).toBe(original)
            }),
          )
        }),
      ),
    60_000,
  )
})
