import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect, it } from "@effect/vitest"
import { Effect, Predicate } from "effect"
import * as Draft from "../Draft/index.ts"
import { computeDiagnosticDiff, type DiagnosticRecord } from "../Policy/index.ts"
import * as Policy from "../Policy/index.ts"
import * as Recipe from "../Recipe/index.ts"
import { VerificationFailure } from "../Verification/index.ts"
import * as Verification from "../Verification/index.ts"
import type { VerificationObservation } from "../Verification/Model.ts"
import { verifyPreview } from "../Verification/Verify.ts"
import { finalizePlan, type Json, type TransformationPlan } from "../Plan/index.ts"
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

describe("declarative transformations API (@effect/vitest)", () => {
  describe("diagnostic diffs and verification policies", () => {
    it("computes diagnostic diffs accurately", () => {
      const baseline: ReadonlyArray<DiagnosticRecord> = [
        {
          code: 2304,
          message: "Cannot find name 'foo'",
          category: "error",
          fileName: "a.ts",
          start: 10,
          length: 3,
        },
        {
          code: 6133,
          message: "'x' is declared but its value is never read",
          category: "warning",
          fileName: "a.ts",
          start: 20,
          length: 1,
        },
      ]

      const proposed: ReadonlyArray<DiagnosticRecord> = [
        {
          code: 6133,
          message: "'x' is declared but its value is never read",
          category: "warning",
          fileName: "a.ts",
          start: 20,
          length: 1,
        },
        {
          code: 2322,
          message: "Type 'string' is not assignable to type 'number'",
          category: "error",
          fileName: "b.ts",
          start: 5,
          length: 6,
        },
      ]

      const diff = computeDiagnosticDiff(baseline, proposed)
      expect(diff.unchanged).toHaveLength(1)
      expect(diff.unchanged[0]!.code).toBe(6133)
      expect(diff.resolved).toHaveLength(1)
      expect(diff.resolved[0]!.code).toBe(2304)
      expect(diff.introduced).toHaveLength(1)
      expect(diff.introduced[0]!.code).toBe(2322)
    })

    it("rejects replacing one error with another even when the total is unchanged", () => {
      // SAFETY: test uses a partial TransformationPlan stub sufficient for verifyPreview.
      const plan = {
        planId: "diagnostic-diff",
        policies: {
          matchCount: {},
          diagnostics: "no-new-errors",
          idempotence: "not-promised",
        },
      } as TransformationPlan
      const diagnosticDiff = computeDiagnosticDiff(
        [{ code: 2304, message: "old", category: "error" }],
        [{ code: 2322, message: "new", category: "error" }],
      )
      const observation: VerificationObservation = {
        actualMatches: 0,
        baselineErrorCount: 1,
        proposedErrorCount: 1,
        diagnosticDiff,
        policyResults: [{ name: "no-new-errors", passed: false }],
      }
      const result = Effect.runSyncExit(
        verifyPreview(
          plan,
          {
            planId: plan.planId,
            snapshotHash: "snapshot",
            files: [],
          },
          observation,
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.cause).toBeDefined()
    })

    it("treats a diagnostic category or span change as a real transition", () => {
      const warning: DiagnosticRecord = {
        code: 9999,
        message: "same diagnostic",
        category: "warning",
        fileName: "a.ts",
        start: 1,
        length: 2,
      }
      const changedCategory = computeDiagnosticDiff([warning], [{ ...warning, category: "error" }])
      expect(changedCategory.resolved).toEqual([warning])
      expect(changedCategory.introduced[0]?.category).toBe("error")

      const changedSpan = computeDiagnosticDiff([warning], [{ ...warning, length: 3 }])
      expect(changedSpan.unchanged).toHaveLength(0)
      expect(changedSpan.resolved).toHaveLength(1)
      expect(changedSpan.introduced).toHaveLength(1)
    })

    effect(
      "enforces declarative policies during verification",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const validRecipe = Recipe.define("policy-valid", {
              version: "1.0.0",
              policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
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

            const failingRecipe = Recipe.define("policy-failing", {
              version: "1.0.0",
              policies: [Policy.matches({ min: 999 })],
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

            // Valid passes verification
            const validPlan = yield* Recipe.run(validRecipe, undefined)
            const verified = yield* Verification.verify(validPlan, validRecipe, undefined)
            expect(verified.diagnosticDiff).toBeDefined()

            // Failing policy is rejected during verification
            const failingPlan = yield* Recipe.run(failingRecipe, undefined)
            const failure = yield* Verification.verify(failingPlan, failingRecipe, undefined).pipe(
              Effect.flip,
            )
            expect(failure).toBeInstanceOf(VerificationFailure)
          }),
        ),
      60_000,
    )

    effect(
      "rejects recipe identity, implementation, input, and toolchain mismatches before rules run",
      () =>
        withFixture(() =>
          Effect.gen(function* () {
            let ruleRan = false
            const input = { value: 1 }
            const author = Recipe.define("identity-author", {
              version: "1.0.0",
              implementationHash: "author-hash",
              policies: [
                Policy.diagnosticDiff("must-not-run", () => {
                  ruleRan = true
                  return true
                }),
              ],
              run: (_input: { readonly value: number }) => Effect.succeed(Draft.empty),
            })
            const plan = yield* Recipe.run(author, input)

            const differentRecipe = Recipe.define("different-recipe", {
              version: "1.0.0",
              implementationHash: "author-hash",
              run: (_input: { readonly value: number }) => Effect.succeed(Draft.empty),
            })
            const recipeResult = yield* Verification.verify(plan, differentRecipe, input).pipe(
              Effect.result,
            )
            expect(recipeResult._tag).toBe("Failure")
            if (recipeResult._tag === "Failure")
              expect(recipeResult.failure._tag).toBe("RecipeMismatch")

            const differentImplementation = Recipe.define("identity-author", {
              version: "1.0.0",
              implementationHash: "different-hash",
              run: (_input: { readonly value: number }) => Effect.succeed(Draft.empty),
            })
            const implementationResult = yield* Verification.verify(
              plan,
              differentImplementation,
              input,
            ).pipe(Effect.result)
            expect(implementationResult._tag).toBe("Failure")
            if (implementationResult._tag === "Failure")
              expect(implementationResult.failure._tag).toBe("RecipeMismatch")

            const inputResult = yield* Verification.verify(plan, author, { value: 2 }).pipe(
              Effect.result,
            )
            expect(inputResult._tag).toBe("Failure")
            if (inputResult._tag === "Failure")
              expect(inputResult.failure._tag).toBe("RecipeInputMismatch")

            const { schemaVersion: _, planId: __, snapshotHash: ___, ...planInput } = plan
            const wrongToolchain = yield* finalizePlan({
              ...planInput,
              toolchain: { ...plan.toolchain, systemVersion: "different-system" },
            })
            const toolchainResult = yield* Verification.verify(wrongToolchain, author, input).pipe(
              Effect.result,
            )
            expect(toolchainResult._tag).toBe("Failure")
            if (toolchainResult._tag === "Failure")
              expect(toolchainResult.failure._tag).toBe("ToolchainMismatch")
            expect(ruleRan).toBe(false)
          }),
        ),
      60_000,
    )

    effect(
      "counts replayed file operations when enforcing idempotence",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const recipe = Recipe.define("non-idempotent-file-create", {
              version: "1.0.0",
              policies: [{ diagnostics: "exact-delta" }, Policy.idempotent()],
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.files.create(
                    project,
                    "src/repeated.ts",
                    "export const repeated = true;\n",
                  )
                }),
            })
            const plan = yield* Recipe.run(recipe, undefined)
            const result = yield* Verification.verify(plan, recipe, undefined).pipe(Effect.result)
            expect(result._tag).toBe("Failure")
            if (result._tag === "Failure") {
              expect(result.failure._tag).toBe("VerificationFailure")
              if (result.failure._tag === "VerificationFailure")
                expect(result.failure.policy).toBe("idempotence")
            }
          }),
        ),
      60_000,
    )

    effect(
      "no-new-errors fails when a plan introduces a syntax error",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const broken = "export const broken = {\n"
            const recipe = Recipe.define("introduce-syntax-error", {
              version: "1.0.0",
              policies: [Policy.noNewErrors()],
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.files.create(project, "src/broken.ts", broken)
                }),
            })
            const plan = yield* Recipe.run(recipe, undefined)
            const result = yield* Verification.verify(plan, recipe, undefined).pipe(Effect.result)
            expect(result._tag).toBe("Failure")
            if (result._tag === "Failure") {
              expect(result.failure._tag).toBe("VerificationFailure")
              if (result.failure._tag === "VerificationFailure")
                expect(result.failure.policy).toBe("diagnostics")
            }
          }),
        ),
      60_000,
    )

    effect(
      "allowErrors permits a listed code through the default no-new-errors gate",
      () =>
        withFixture((_, app) =>
          Effect.gen(function* () {
            const source = `export const n: number = "string";\n`
            const observe = Recipe.define("observe-introduced-error", {
              version: "1.0.0",
              policies: [{ diagnostics: "exact-delta" }],
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.files.create(project, "src/assign.ts", source)
                }),
            })
            const observedPlan = yield* Recipe.run(observe, undefined)
            const observed = yield* Verification.verify(observedPlan, observe, undefined)
            const introduced = observed.diagnosticDiff.introduced.filter(
              (diagnostic) => diagnostic.category === "error",
            )
            expect(introduced.length).toBeGreaterThan(0)
            const code = introduced[0]!.code
            const introducedKeys = new Set(
              introduced.map((diagnostic) => String(diagnostic.code).replace(/^TS/, "")),
            )
            let otherCode = 1
            while (introducedKeys.has(String(otherCode))) otherCode += 1

            const allowed = Recipe.define("allow-observed-error", {
              version: "1.0.0",
              policies: [Policy.allowErrors({ code })],
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.files.create(project, "src/assign.ts", source)
                }),
            })
            const denied = Recipe.define("deny-other-error", {
              version: "1.0.0",
              policies: [Policy.allowErrors({ code: otherCode })],
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)
                  return yield* Draft.files.create(project, "src/assign.ts", source)
                }),
            })

            const allowedPlan = yield* Recipe.run(allowed, undefined)
            const deniedPlan = yield* Recipe.run(denied, undefined)
            const allowedResult = yield* Verification.verify(allowedPlan, allowed, undefined)
            const deniedResult = yield* Verification.verify(deniedPlan, denied, undefined).pipe(
              Effect.result,
            )
            expect(
              allowedResult.diagnosticDiff.introduced.some(
                (diagnostic) => diagnostic.code === code,
              ),
            ).toBe(true)
            expect(deniedResult._tag).toBe("Failure")
            if (deniedResult._tag === "Failure")
              expect(deniedResult.failure._tag).toBe("VerificationFailure")
          }),
        ),
      60_000,
    )
  })

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
            // Environment inputs are not reported by the TS 7 native host, so
            // they are not invented here. Directory / missing / realpath entries
            // are recorded only when the host actually observes them.
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
              Predicate.isObject(parsedUnknown) && !Array.isArray(parsedUnknown)
                ? parsedUnknown
                : {}
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
            expect(plan.sources.some((source) => source.fileName === "tsconfig.base.json")).toBe(
              true,
            )
            expect(
              plan.sources.some(
                (source) => source.kind === "directory" && source.fileName === "src",
              ),
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
})
