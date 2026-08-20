import {
  nodeFsPromises as Fs,
  path as Path,
  layer as nodeLayer,
  pathLayer,
} from "../../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import * as Application from "../../Application/index.ts"
import * as Draft from "../../Draft/index.ts"
import * as Recipe from "../../Recipe/index.ts"
import * as Verification from "../../Verification/index.ts"
import { WorkspaceSnapshot } from "../../Workspace/index.ts"
import { withFixture } from "../../test/declarative-fixture.ts"
import { wrapTargetInput, type WrapTargetInput } from "../../test/wrap-target-input.ts"
import { applicationLayer, makeApplicationLayerNode } from "./Layer.ts"

const exists = (fileName: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    Fs.stat(fileName).then(
      () => true,
      () => false,
    ),
  )

describe("Node application transaction recovery", () => {
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
