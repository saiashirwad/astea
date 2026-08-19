import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"
import * as Query from "./index.ts"

const looksLikeDefaultLibrary = (fileName: string): boolean =>
  /lib\.(es|dom|scripthost|webworker)|typescript[/\\]lib[/\\]/i.test(fileName)

describe("project-owned query sources", () => {
  effect(
    "Query.identifiers(project) stays on project-owned files",
    () =>
      withFixture((_, app) =>
        Effect.gen(function* () {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot(
            {},
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              const files = yield* project.files
              const ownedPaths = new Set(files.map((file) => file.path))
              const fromProject = yield* Query.collect(Query.identifiers(project))
              const fromFiles = yield* Query.collect(Query.identifiers(files))

              expect(fromProject.length).toBeGreaterThan(0)
              expect(fromProject.length).toBe(fromFiles.length)
              expect(fromProject.every((selection) => ownedPaths.has(selection.fileName))).toBe(
                true,
              )
              expect(
                fromProject.some((selection) => looksLikeDefaultLibrary(selection.fileName)),
              ).toBe(false)
            }),
          )
        }),
      ),
    60_000,
  )

  effect(
    "Query.within matches documented ** globs on fixture files",
    () =>
      withFixture((_, app) =>
        Effect.gen(function* () {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot(
            {},
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              const all = yield* Query.collect(Query.identifiers(project))
              const nested = yield* Query.collect(
                Query.identifiers(project).pipe(Query.within("src/**/*.ts")),
              )
              expect(all.length).toBeGreaterThan(0)
              expect(nested.length).toBe(all.length)
              expect(nested.every((selection) => selection.fileName.startsWith("src/"))).toBe(true)
              expect(nested.some((selection) => selection.fileName === "src/library.ts")).toBe(true)
            }),
          )
        }),
      ),
    60_000,
  )
})
