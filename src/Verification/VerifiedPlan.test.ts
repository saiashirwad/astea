import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect, Predicate } from "effect"
import * as Draft from "../Draft/index.ts"
import * as Recipe from "../Recipe/index.ts"
import * as Verification from "../Verification/index.ts"
import type { Json } from "../Evidence/index.ts"
import { finalizePlan, type TransformationPlan } from "../Plan/index.ts"
import { WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

const didMutate = (write: () => void): boolean => {
  try {
    write()
    return true
  } catch {
    return false
  }
}

interface TsConfigDocument {
  readonly compilerOptions?: Readonly<Record<string, Json>>
  readonly include?: Json
}

describe("issued verified plans and project identity", () => {
  effect(
    "rejects a structurally decoded plan whose paths are not canonical",
    () =>
      withFixture((_, app) =>
        Effect.gen(function* () {
          const recipe = Recipe.define("unvalidated-paths", {
            version: "1.0.0",
            policies: [{ diagnostics: "exact-delta" }],
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.files.create(project, "src/created.ts", "export {}\n")
              }),
          })
          const plan = yield* Recipe.run(recipe, undefined)
          const unvalidated: TransformationPlan = {
            ...plan,
            sources: plan.sources.map((source) => ({
              ...source,
              fileName: `./${source.fileName}`,
            })),
            edits: plan.edits.map((edit) => ({ ...edit, fileName: `./${edit.fileName}` })),
          }
          const verified = yield* Verification.verify(unvalidated, recipe, undefined).pipe(
            Effect.result,
          )
          const previewed = yield* Verification.of(unvalidated).pipe(Effect.result)
          expect(verified._tag).toBe("Failure")
          expect(previewed._tag).toBe("Failure")
        }),
      ),
    60_000,
  )

  effect(
    "rejects a finalized plan whose project config is not the live Workspace identity",
    () =>
      withFixture((_, app) =>
        Effect.gen(function* () {
          const recipe = Recipe.define("identity-mismatch", {
            version: "1.0.0",
            policies: [{ diagnostics: "exact-delta" }],
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.files.create(project, "src/created.ts", "export {}\n")
              }),
          })
          const plan = yield* Recipe.run(recipe, undefined)
          const { schemaVersion: _, planId: __, snapshotHash: ___, ...input } = plan
          const mismatched = yield* finalizePlan({
            ...input,
            projects: input.projects.map((project) => ({
              ...project,
              configFileName: "other.json",
            })),
          })
          const verified = yield* Verification.verify(mismatched, recipe, undefined).pipe(
            Effect.result,
          )
          const previewed = yield* Verification.of(mismatched).pipe(Effect.result)
          expect(verified._tag).toBe("Failure")
          expect(previewed._tag).toBe("Failure")
        }),
      ),
    60_000,
  )

  effect(
    "stales verify and apply when an extends parent or other recorded manifest input changes",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          const originalConfig = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "tsconfig.json"), "utf8"),
          )
          yield* Effect.tryPromise(() =>
            Fs.writeFile(
              Path.join(root, "tsconfig.base.json"),
              `${JSON.stringify({ compilerOptions: { strict: true } }, null, 2)}\n`,
            ),
          )
          const parsedUnknown: unknown = JSON.parse(originalConfig)
          const parsed: TsConfigDocument =
            Predicate.isObject(parsedUnknown) && !Array.isArray(parsedUnknown) ? parsedUnknown : {}
          yield* Effect.tryPromise(() =>
            Fs.writeFile(
              Path.join(root, "tsconfig.json"),
              `${JSON.stringify(
                {
                  extends: "./tsconfig.base.json",
                  compilerOptions: parsed.compilerOptions ?? {},
                  include: parsed.include ?? ["src/**/*.ts"],
                },
                null,
                2,
              )}\n`,
            ),
          )

          const recipe = Recipe.define("manifest-stale", {
            version: "1.0.0",
            policies: [{ diagnostics: "exact-delta" }],
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.files.create(project, "src/created.ts", "export {}\n")
              }),
          })
          const plan = yield* Recipe.run(recipe, undefined)
          expect(plan.sources.some((source) => source.fileName === "tsconfig.json")).toBe(true)
          expect(plan.sources.some((source) => source.fileName === "tsconfig.base.json")).toBe(true)
          expect(
            plan.sources.some((source) => source.kind === "directory" && source.fileName === "src"),
          ).toBe(true)

          yield* Effect.tryPromise(() =>
            Fs.writeFile(
              Path.join(root, "tsconfig.base.json"),
              `${JSON.stringify({ compilerOptions: { strict: false } }, null, 2)}\n`,
            ),
          )
          const verified = yield* Verification.verify(plan, recipe, undefined).pipe(Effect.result)
          const previewed = yield* Verification.of(plan).pipe(Effect.result)
          expect(verified._tag).toBe("Failure")
          expect(previewed._tag).toBe("Failure")
          if (verified._tag === "Failure") expect(verified.failure._tag).toBe("StalePlanError")
          if (previewed._tag === "Failure") expect(previewed.failure._tag).toBe("StalePlanError")
        }),
      ),
    60_000,
  )

  effect(
    "freezes nested values on an issued verified plan and still exposes them for apply",
    () =>
      withFixture((_, app) =>
        Effect.gen(function* () {
          const recipe = Recipe.define("issued-freeze", {
            version: "1.0.0",
            policies: [{ diagnostics: "exact-delta" }],
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.files.create(project, "src/created.ts", "export {}\n")
              }),
          })
          const plan = yield* Recipe.run(recipe, undefined)
          const verified = yield* Verification.verify(plan, recipe, undefined)
          const project = verified.plan.projects[0]
          const file = verified.preview.files[0]
          expect(project).toBeDefined()
          expect(file).toBeDefined()
          if (project === undefined || file === undefined) return
          const originalConfig = project.configFileName
          const originalFileName = file.fileName
          expect(
            didMutate(() => {
              // SAFETY: the test asserts the issued capability rejects mutation.
              const target = project as { configFileName: string }
              target.configFileName = "mutated.json"
            }),
          ).toBe(false)
          expect(
            didMutate(() => {
              // SAFETY: the test asserts nested preview state is not caller-mutable.
              const target = file as { fileName: string }
              target.fileName = "src/mutated.ts"
            }),
          ).toBe(false)
          expect(project.configFileName).toBe(originalConfig)
          expect(file.fileName).toBe(originalFileName)
          expect(verified.plan.planId).toBe(plan.planId)
          expect(verified.diagnosticDiff).toBeDefined()
        }),
      ),
    60_000,
  )
})
