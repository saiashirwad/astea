import {
  nodeFsPromises as Fs,
  path as Path,
  layer as nodeLayer,
  pathLayer,
} from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect, FileSystem, Layer, PlatformError } from "effect"
import * as Application from "../Application/index.ts"
import * as Draft from "../Draft/index.ts"
import * as Policy from "../Policy/index.ts"
import * as Recipe from "../Recipe/index.ts"
import * as Verification from "../Verification/index.ts"
import { WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"
import { wrapTargetInput, type WrapTargetInput } from "../test/wrap-target-input.ts"
import { applicationLayer, makeApplicationLayerNode } from "./Application.ts"

const exists = (fileName: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    Fs.stat(fileName).then(
      () => true,
      () => false,
    ),
  )

describe("Node application transactions", () => {
  effect("rejects a create-target race without overwriting the raced file", () =>
    withFixture((root, app) =>
      Effect.gen(function* () {
        const recipe = Recipe.define("create-race", {
          version: "1.0.0",
          policies: [Policy.noNewErrors()],
          run: () =>
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              return yield* Draft.files.create(project, "src/raced.ts", "")
            }),
        })
        const plan = yield* Recipe.run(recipe, undefined)
        const verified = yield* Verification.verify(plan, recipe, undefined)
        const target = Path.join(root, "src/raced.ts")
        yield* Effect.promise(() => Fs.writeFile(target, "created by another process\n"))

        const result = yield* Application.apply(verified).pipe(
          Effect.provide(makeApplicationLayerNode(root)),
          Effect.result,
        )
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure._tag).toBe("StalePlanError")
        expect(yield* Effect.promise(() => Fs.readFile(target, "utf8"))).toBe(
          "created by another process\n",
        )
      }),
    ),
  )

  effect("uses a no-clobber commit when a create target appears after the final check", () =>
    withFixture((root, app) =>
      Effect.gen(function* () {
        const recipe = Recipe.define("create-toctou", {
          version: "1.0.0",
          policies: [{ diagnostics: "exact-delta" }],
          run: () =>
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              return yield* Draft.files.create(project, "src/toctou.ts", "planned\n")
            }),
        })
        const plan = yield* Recipe.run(recipe, undefined)
        const verified = yield* Verification.verify(plan, recipe, undefined)
        const target = Path.join(root, "src/toctou.ts")
        const realFs = yield* FileSystem.FileSystem
        let injected = false
        const racingFs = FileSystem.FileSystem.of({
          ...realFs,
          link: (from, to) => {
            if (injected) return realFs.link(from, to)
            injected = true
            return realFs
              .writeFileString(to, "raced\n")
              .pipe(Effect.flatMap(() => realFs.link(from, to)))
          },
        })
        const testLayer = Layer.mergeAll(
          applicationLayer(root),
          Layer.succeed(FileSystem.FileSystem, racingFs),
          pathLayer,
        )

        const result = yield* Application.apply(verified).pipe(
          Effect.provide(testLayer),
          Effect.result,
        )
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure._tag).toBe("ApplicationFailure")
        expect(yield* Effect.promise(() => Fs.readFile(target, "utf8"))).toBe("raced\n")
      }),
    ).pipe(Effect.provide(nodeLayer)),
  )

  effect("creates, moves, and deletes empty files without using empty text as absence", () =>
    withFixture((root, app) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all([
            Fs.writeFile(Path.join(root, "src/move-empty.ts"), ""),
            Fs.writeFile(Path.join(root, "src/delete-empty.ts"), ""),
          ]),
        )
        const recipe = Recipe.define("empty-file-lifecycle", {
          version: "1.0.0",
          policies: [{ diagnostics: "exact-delta" }],
          run: () =>
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              const create = yield* Draft.files.create(project, "src/created-empty.ts", "")
              const move = yield* Draft.files.move(
                project,
                "src/move-empty.ts",
                "src/moved-empty.ts",
              )
              const remove = yield* Draft.files.delete(project, "src/delete-empty.ts")
              return Draft.concat(create, move, remove)
            }),
        })

        const plan = yield* Recipe.run(recipe, undefined)
        const verified = yield* Verification.verify(plan, recipe, undefined)
        yield* Application.apply(verified).pipe(Effect.provide(makeApplicationLayerNode(root)))

        expect(yield* exists(Path.join(root, "src/created-empty.ts"))).toBe(true)
        expect(
          yield* Effect.promise(() => Fs.readFile(Path.join(root, "src/created-empty.ts"), "utf8")),
        ).toBe("")
        expect(yield* exists(Path.join(root, "src/move-empty.ts"))).toBe(false)
        expect(yield* exists(Path.join(root, "src/moved-empty.ts"))).toBe(true)
        expect(
          yield* Effect.promise(() => Fs.readFile(Path.join(root, "src/moved-empty.ts"), "utf8")),
        ).toBe("")
        expect(yield* exists(Path.join(root, "src/delete-empty.ts"))).toBe(false)
      }),
    ),
  )

  effect("rolls back earlier files in reverse order and removes all staged temporaries", () =>
    withFixture((root, app) =>
      Effect.gen(function* () {
        const input: WrapTargetInput = {
          project: app,
          declarationFile: "src/library.ts",
          property: "value",
        }
        const plan = yield* Recipe.run(wrapTargetInput, input)
        const verified = yield* Verification.verify(plan, wrapTargetInput, input)
        const originalConsumer = yield* Effect.promise(() =>
          Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
        )
        const originalReexport = yield* Effect.promise(() =>
          Fs.readFile(Path.join(root, "src/reexport-consumer.ts"), "utf8"),
        )
        const realFs = yield* FileSystem.FileSystem
        let renameCount = 0
        const failingFs = FileSystem.FileSystem.of({
          ...realFs,
          rename: (from, to) => {
            renameCount++
            return renameCount === 2
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: to,
                  }),
                )
              : realFs.rename(from, to)
          },
        })
        const testLayer = Layer.mergeAll(
          applicationLayer(root),
          Layer.succeed(FileSystem.FileSystem, failingFs),
          pathLayer,
        )

        const result = yield* Application.apply(verified).pipe(
          Effect.provide(testLayer),
          Effect.result,
        )
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("ApplicationFailure")
          if (result.failure._tag === "ApplicationFailure")
            expect(result.failure.rolledBack).toBe(true)
        }
        expect(
          yield* Effect.promise(() => Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")),
        ).toBe(originalConsumer)
        expect(
          yield* Effect.promise(() =>
            Fs.readFile(Path.join(root, "src/reexport-consumer.ts"), "utf8"),
          ),
        ).toBe(originalReexport)
        const names = yield* Effect.promise(() => Fs.readdir(root, { recursive: true }))
        expect(names.some((name) => name.includes(".safemods-"))).toBe(false)
      }),
    ).pipe(Effect.provide(nodeLayer)),
  )

  effect("rejects a symlinked project subdirectory that escapes the workspace", () =>
    withFixture((root, app) =>
      Effect.gen(function* () {
        const outside = yield* Effect.promise(() =>
          Fs.mkdtemp(Path.join(Path.dirname(root), "safemods-outside-")),
        )
        const link = Path.join(root, "src", "escape")
        yield* Effect.promise(() => Fs.symlink(outside, link, "dir"))
        const recipe = Recipe.define("symlink-escape", {
          version: "1.0.0",
          policies: [{ diagnostics: "exact-delta" }],
          run: () =>
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              return yield* Draft.files.create(
                project,
                "src/escape/outside.ts",
                "export const escaped = true;\n",
              )
            }),
        })
        const plan = yield* Recipe.run(recipe, undefined)
        const verified = yield* Verification.verify(plan, recipe, undefined)
        const result = yield* Application.apply(verified).pipe(
          Effect.provide(makeApplicationLayerNode(root)),
          Effect.result,
        )
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure._tag).toBe("ApplicationFailure")
        expect(yield* exists(Path.join(outside, "outside.ts"))).toBe(false)
        yield* Effect.promise(() => Fs.rm(outside, { recursive: true, force: true }))
      }),
    ),
  )
})
