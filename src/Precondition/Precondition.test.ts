import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"
import * as Precondition from "./index.ts"

describe("precondition path globs", () => {
  effect(
    "pathMatches accepts documented ** and zero-directory **/ cases",
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
              const owned = files.map((file) => file.path).sort()

              const starStar = yield* Precondition.filesMatching(
                project,
                Precondition.pathMatches("src/**/*.ts"),
              )
              expect(starStar.map((file) => file.path).sort()).toEqual(owned)

              const zeroDirectory = yield* Precondition.filesMatching(
                project,
                Precondition.pathMatches("src/**/library.ts"),
              )
              expect(zeroDirectory.some((file) => file.path === "src/library.ts")).toBe(true)

              const anyDirectory = yield* Precondition.filesMatching(
                project,
                Precondition.pathMatches("**/library.ts"),
              )
              expect(anyDirectory.some((file) => file.path === "src/library.ts")).toBe(true)
            }),
          )
        }),
      ),
    60_000,
  )
})
