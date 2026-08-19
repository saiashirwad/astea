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
import type { VerifiedPlan } from "../Verification/index.ts"
import { ConfiguredProject, Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"
import { wrapTargetInput, type WrapTargetInput } from "../test/wrap-target-input.ts"
import { applicationLayer, makeApplicationLayerNode } from "./Application.ts"

const didMutate = (write: () => void): boolean => {
  try {
    write()
    return true
  } catch {
    return false
  }
}

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
        let installCount = 0
        const failingFs = FileSystem.FileSystem.of({
          ...realFs,
          rename: (from, to) => {
            if (from.includes(".safemods-") || !to.includes(".safemods-swap-")) {
              return realFs.rename(from, to)
            }
            installCount++
            return installCount === 2
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

  effect("rejects a public-brand forgery and a stolen-brand clone with mutated preview text", () =>
    withFixture((root, app) =>
      Effect.gen(function* () {
        const contents = "export const created = true;\n"
        const recipe = Recipe.define("forged-apply", {
          version: "1.0.0",
          policies: [{ diagnostics: "exact-delta" }],
          run: () =>
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              return yield* Draft.files.create(project, "src/created.ts", contents)
            }),
        })
        const plan = yield* Recipe.run(recipe, undefined)
        const verified = yield* Verification.verify(plan, recipe, undefined)
        const publicBrand = Symbol.for("@safemods/internal/VerifiedPlan")
        const publicForgery = {
          [publicBrand]: publicBrand,
          plan: verified.plan,
          preview: verified.preview,
          receipt: verified.receipt,
        }
        const stolen = Object.getOwnPropertySymbols(verified)[0]
        const clonedPreview = structuredClone(verified.preview)
        const stolenForgery = {
          plan: structuredClone(verified.plan),
          preview: {
            ...clonedPreview,
            files: clonedPreview.files.map((file) =>
              file.after.exists
                ? {
                    ...file,
                    after: { exists: true as const, text: "forged-bytes\n", hash: file.after.hash },
                  }
                : file,
            ),
          },
          receipt: structuredClone(verified.receipt),
        }
        if (stolen !== undefined) {
          const brand = Object.getOwnPropertyDescriptor(verified, stolen)?.value
          if (brand !== undefined) Object.assign(stolenForgery, { [stolen]: brand })
        }
        const publicResult = yield* Application.apply(
          // SAFETY: the test applies a caller-constructed public-brand object.
          publicForgery as VerifiedPlan,
        ).pipe(Effect.provide(makeApplicationLayerNode(root)), Effect.result)
        const stolenResult = yield* Application.apply(
          // SAFETY: the test applies a cloned capability with a stolen brand.
          stolenForgery as VerifiedPlan,
        ).pipe(Effect.provide(makeApplicationLayerNode(root)), Effect.result)
        expect(publicResult._tag).toBe("Failure")
        expect(stolenResult._tag).toBe("Failure")
        expect(yield* exists(Path.join(root, "src/created.ts"))).toBe(false)
      }),
    ),
  )

  effect("applies an unmodified verified plan and rejects a live project-config mismatch", () =>
    withFixture((root, app) =>
      Effect.gen(function* () {
        const contents = "export const created = true;\n"
        const recipe = Recipe.define("genuine-apply", {
          version: "1.0.0",
          policies: [{ diagnostics: "exact-delta" }],
          run: () =>
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              return yield* Draft.files.create(project, "src/created.ts", contents)
            }),
        })
        const plan = yield* Recipe.run(recipe, undefined)
        const verified = yield* Verification.verify(plan, recipe, undefined)
        const file = verified.preview.files[0]
        expect(file).toBeDefined()
        if (file === undefined) return
        const originalFileName = file.fileName
        expect(
          didMutate(() => {
            // SAFETY: the test asserts nested issued preview state is frozen.
            ;(file as { fileName: string }).fileName = "src/mutated.ts"
          }),
        ).toBe(false)
        expect(file.fileName).toBe(originalFileName)

        const other = ConfiguredProject.make({ id: app.id, config: "other.json" })
        const mismatchedWorkspace = Workspace.layer({ projects: [other] }, { cwd: root })
        const mismatch = yield* Application.apply(verified).pipe(
          Effect.provide(makeApplicationLayerNode(root).pipe(Layer.provide(mismatchedWorkspace))),
          Effect.result,
        )
        expect(mismatch._tag).toBe("Failure")
        expect(yield* exists(Path.join(root, "src/created.ts"))).toBe(false)

        const receipt = yield* Application.apply(verified).pipe(
          Effect.provide(makeApplicationLayerNode(root)),
        )
        expect(receipt.planId).toBe(plan.planId)
        expect(
          yield* Effect.promise(() => Fs.readFile(Path.join(root, "src/created.ts"), "utf8")),
        ).toBe(contents)
      }),
    ),
  )

  effect("rechecks source hashes at application instead of trusting a later disk edit", () =>
    withFixture((root, app) =>
      Effect.gen(function* () {
        const recipe = Recipe.define("stale-apply", {
          version: "1.0.0",
          policies: [{ diagnostics: "exact-delta" }],
          run: () =>
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
                module: "./library.js",
                name: "TargetInput",
              })
            }),
        })
        const plan = yield* Recipe.run(recipe, undefined)
        const verified = yield* Verification.verify(plan, recipe, undefined)
        const original = yield* Effect.promise(() =>
          Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
        )
        yield* Effect.promise(() => Fs.writeFile(Path.join(root, "src/consumer.ts"), "changed\n"))
        const result = yield* Application.apply(verified).pipe(
          Effect.provide(makeApplicationLayerNode(root)),
          Effect.result,
        )
        expect(result._tag).toBe("Failure")
        expect(
          yield* Effect.promise(() => Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")),
        ).toBe("changed\n")
        expect(original).not.toContain("changed\n")
      }),
    ),
  )

  effect("does not overwrite an injected write between the existing-file check and replace", () =>
    withFixture((root, app) =>
      Effect.gen(function* () {
        const recipe = Recipe.define("existing-toctou", {
          version: "1.0.0",
          policies: [{ diagnostics: "exact-delta" }],
          run: () =>
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
                module: "./library.js",
                name: "TargetInput",
              })
            }),
        })
        const plan = yield* Recipe.run(recipe, undefined)
        const verified = yield* Verification.verify(plan, recipe, undefined)
        const target = Path.join(root, "src/consumer.ts")
        const original = yield* Effect.promise(() => Fs.readFile(target, "utf8"))
        const realFs = yield* FileSystem.FileSystem
        let injected = false
        let renamedOverLiveTarget = false
        const racingFs = FileSystem.FileSystem.of({
          ...realFs,
          rename: (from, to) =>
            Effect.gen(function* () {
              const ontoLiveTarget =
                to === target &&
                from.includes(".safemods-") &&
                from.endsWith(".tmp") &&
                !from.includes(".safemods-swap-")
              if (ontoLiveTarget) renamedOverLiveTarget = true
              if (!injected && (from === target || ontoLiveTarget)) {
                injected = true
                yield* realFs.writeFileString(target, "raced\n")
              }
              return yield* realFs.rename(from, to)
            }),
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
        expect(injected).toBe(true)
        expect(renamedOverLiveTarget).toBe(false)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure._tag).toBe("StalePlanError")
        const onDisk = yield* Effect.promise(() => Fs.readFile(target, "utf8"))
        expect(onDisk).toBe("raced\n")
        expect(onDisk).not.toBe(original)
        const planned = verified.preview.files.find((file) => file.fileName === "src/consumer.ts")
        expect(planned?.after.exists).toBe(true)
        if (planned?.after.exists === true) expect(onDisk).not.toBe(planned.after.text)
      }),
    ).pipe(Effect.provide(nodeLayer)),
  )

  effect("serializes overlapping applies so existing files are not torn", () =>
    withFixture((root, app) =>
      Effect.gen(function* () {
        const input: WrapTargetInput = {
          project: app,
          declarationFile: "src/library.ts",
          property: "value",
        }
        const plan = yield* Recipe.run(wrapTargetInput, input)
        const verified = yield* Verification.verify(plan, wrapTargetInput, input)
        const consumerPath = Path.join(root, "src/consumer.ts")
        const reexportPath = Path.join(root, "src/reexport-consumer.ts")
        const originalConsumer = yield* Effect.promise(() => Fs.readFile(consumerPath, "utf8"))
        const originalReexport = yield* Effect.promise(() => Fs.readFile(reexportPath, "utf8"))

        const results = yield* Effect.all(
          [
            Application.apply(verified).pipe(
              Effect.provide(makeApplicationLayerNode(root)),
              Effect.result,
            ),
            Application.apply(verified).pipe(
              Effect.provide(makeApplicationLayerNode(root)),
              Effect.result,
            ),
          ],
          { concurrency: "unbounded" },
        )
        const consumer = yield* Effect.promise(() => Fs.readFile(consumerPath, "utf8"))
        const reexport = yield* Effect.promise(() => Fs.readFile(reexportPath, "utf8"))
        const plannedConsumer = verified.preview.files.find(
          (file) => file.fileName === "src/consumer.ts",
        )
        const plannedReexport = verified.preview.files.find(
          (file) => file.fileName === "src/reexport-consumer.ts",
        )
        expect(plannedConsumer?.after.exists).toBe(true)
        expect(plannedReexport?.after.exists).toBe(true)
        if (plannedConsumer?.after.exists !== true || plannedReexport?.after.exists !== true) return
        expect(consumer === originalConsumer || consumer === plannedConsumer.after.text).toBe(true)
        expect(reexport === originalReexport || reexport === plannedReexport.after.text).toBe(true)
        expect(consumer === originalConsumer).toBe(reexport === originalReexport)
        const successes = results.filter((result) => result._tag === "Success")
        expect(successes.length).toBe(1)
        const names = yield* Effect.promise(() => Fs.readdir(root, { recursive: true }))
        expect(names.some((name) => name.includes(".safemods-"))).toBe(false)
      }),
    ),
  )

  effect("recovers a planted unfinished journal and leftover temps before a later apply", () =>
    withFixture((root, app) =>
      Effect.gen(function* () {
        const contents = "export const created = true;\n"
        const recipe = Recipe.define("after-recovery", {
          version: "1.0.0",
          policies: [{ diagnostics: "exact-delta" }],
          run: () =>
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)
              return yield* Draft.files.create(project, "src/created.ts", contents)
            }),
        })
        const plan = yield* Recipe.run(recipe, undefined)
        const verified = yield* Verification.verify(plan, recipe, undefined)
        const leftover = Path.join(root, "src/library.ts.safemods-dead.tmp")
        const unlisted = Path.join(root, "src/extra.safemods-orphan.tmp")
        const orphan = Path.join(root, "src/orphan.ts")
        const journalPath = Path.join(root, ".safemods-apply.journal")
        yield* Effect.promise(() =>
          Promise.all([
            Fs.writeFile(leftover, "stale-temp\n"),
            Fs.writeFile(unlisted, "unlisted-temp\n"),
            Fs.writeFile(orphan, "partial-commit\n"),
            Fs.writeFile(
              journalPath,
              JSON.stringify({
                planId: "unfinished",
                phase: "open",
                files: [
                  {
                    target: orphan,
                    temporary: leftover,
                    before: { exists: false },
                  },
                ],
                createdDirectories: [],
              }),
            ),
          ]),
        )

        const receipt = yield* Application.apply(verified).pipe(
          Effect.provide(makeApplicationLayerNode(root)),
        )
        expect(receipt.planId).toBe(plan.planId)
        expect(yield* exists(leftover)).toBe(false)
        expect(yield* exists(unlisted)).toBe(false)
        expect(yield* exists(orphan)).toBe(false)
        expect(yield* exists(journalPath)).toBe(false)
        expect(
          yield* Effect.promise(() => Fs.readFile(Path.join(root, "src/created.ts"), "utf8")),
        ).toBe(contents)
      }),
    ),
  )
})
