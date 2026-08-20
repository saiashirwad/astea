import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import * as Application from "../Application/index.ts"
import * as Draft from "../Draft/index.ts"
import { applicationLayerNode } from "../Node/index.ts"
import * as Pattern from "../Pattern/index.ts"
import * as Policy from "../Policy/index.ts"
import * as Precondition from "../Precondition/index.ts"
import * as Query from "../Query/index.ts"
import * as Recipe from "../Recipe/index.ts"
import * as Verification from "../Verification/index.ts"
import { WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("recipe policy and concurrent composition", () => {
  effect(
    "Preconditions respect Recipe.pipe overlays when evaluating chained transformations",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          // Recipe 1: Adds import of publicTarget from ./barrel.js to consumer.ts
          const step1 = Recipe.define("step1-add-barrel-import", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
                  module: "./barrel.js",
                  name: "publicTarget",
                })
              }),
          })

          // Recipe 2: Uses Precondition.hasImport("./barrel.js") to find matching files in the overlay
          const step2 = Recipe.define("step2-transform-matching", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)

                // Step 2 sees the overlay from Step 1 containing import of ./barrel.js in consumer.ts
                const barrelFiles = yield* Precondition.filesMatching(
                  project,
                  Precondition.hasImport("./barrel.js"),
                )
                expect(barrelFiles.map((f) => f.path)).toEqual([
                  "src/consumer.ts",
                  "src/reexport-consumer.ts",
                ])

                const libraryFile = yield* project.file("src/library.ts")
                const targetSymbol = yield* libraryFile.symbolNamed("target")

                const targetCalls = yield* Query.calls(barrelFiles).pipe(
                  Query.where(Query.resolvesTo(targetSymbol, { location: (c) => c.expression })),
                  Query.collect,
                )

                return yield* Draft.replaceEach(targetCalls, ({ project: p, value: call }) =>
                  Draft.wrapArgument(p, call, 0, (arg) => `publicTarget(${arg})`),
                )
              }),
          })

          const pipeline = Recipe.pipe(step1, step2)
          const plan = yield* Recipe.run(pipeline, undefined)
          const verified = yield* Verification.verify(plan, pipeline, undefined)
          yield* Application.apply(verified).pipe(Effect.provide(applicationLayerNode))

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
          )
          expect(consumerContent).toContain("publicTarget")
          expect(consumerContent).toContain("renamed(/* keep this comment */ publicTarget(1))")
        }),
      ),
    60_000,
  )

  effect(
    "composes concurrent recipes with Recipe.all and executes conditionally with Recipe.branch",
    () =>
      withFixture((_, app) =>
        Effect.gen(function* () {
          const recipeA = Recipe.define("recipe-a", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
                  module: "effect",
                  name: "Chunk",
                })
              }),
          })

          const recipeB = Recipe.define("recipe-b", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.imports.addNamed(project, "src/reexport-consumer.ts", {
                  module: "effect",
                  name: "HashSet",
                })
              }),
          })

          const parallelRecipe = Recipe.all([recipeA, recipeB])
          const branchedRecipe = Recipe.branch(
            () => true,
            parallelRecipe,
            Recipe.define("noop", { version: "1.0.0", run: () => Effect.succeed(Draft.empty) }),
          )

          const plan = yield* Recipe.run(branchedRecipe, undefined)
          expect(plan.edits).toHaveLength(2)
        }),
      ),
    60_000,
  )

  effect("preserves compiled durable policies and runtime rules across combinators", () =>
    Effect.sync(() => {
      const guarded = Recipe.define("guarded", {
        version: "1.0.0",
        policies: [Policy.atMostFiles(2), Policy.idempotent(), Policy.fixesError(999)],
        run: () => Effect.succeed(Draft.empty),
      })
      const bounded = Recipe.define("bounded", {
        version: "1.0.0",
        policies: [Policy.matches({ min: 3 })],
        run: () => Effect.succeed(Draft.empty),
      })

      const composedCases: ReadonlyArray<
        readonly [Recipe.Recipe<any, any, any>, number | undefined]
      > = [
        [Recipe.pipe(guarded, bounded), 3],
        [Recipe.all([guarded, bounded]), 3],
        [Recipe.branch(() => true, guarded, bounded), 3],
        [Recipe.when(() => true, guarded), undefined],
      ]
      for (const [composed, expectedMin] of composedCases) {
        expect(composed.policies.maxAffectedFiles).toBe(2)
        expect(composed.policies.matchCount.min).toBe(expectedMin)
        expect(composed.policies.idempotence).toBe("required")
        expect(composed.rules.map((rule) => rule.name)).toContain("fixes-error:TS999")
      }
    }),
  )

  effect("Recipe.pipe, all, and branch keep the stricter child policy", () =>
    Effect.sync(() => {
      const stricter = Recipe.define("stricter-policy", {
        version: "1.0.0",
        policies: [
          Policy.atMostFiles(2),
          Policy.matches({ min: 3, max: 4 }),
          Policy.noNewErrors(),
          Policy.idempotent(),
        ],
        run: () => Effect.succeed(Draft.empty),
      })
      const looser = Recipe.define("looser-policy", {
        version: "1.0.0",
        policies: [
          Policy.atMostFiles(10),
          Policy.matches({ min: 1, max: 20 }),
          { diagnostics: "exact-delta" },
        ],
        run: () => Effect.succeed(Draft.empty),
      })

      const composed = [
        Recipe.pipe(stricter, looser),
        Recipe.pipe(looser, stricter),
        Recipe.all([stricter, looser]),
        Recipe.branch(() => true, stricter, looser),
      ]
      for (const recipe of composed) {
        expect(recipe.policies.maxAffectedFiles).toBe(stricter.policies.maxAffectedFiles)
        expect(recipe.policies.matchCount.min).toBe(stricter.policies.matchCount.min)
        expect(recipe.policies.matchCount.max).toBe(stricter.policies.matchCount.max)
        expect(recipe.policies.diagnostics).toBe(stricter.policies.diagnostics)
        expect(recipe.policies.idempotence).toBe(stricter.policies.idempotence)
      }
    }),
  )

  effect(
    "Recipe.pipe keeps earlier and later evidence when a later stage makes no edits",
    () =>
      withFixture((_, app) =>
        Effect.gen(function* () {
          const editStage = Recipe.define("pipe-edit-stage", {
            version: "1.0.0",
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
          const auditStage = Recipe.define("pipe-audit-stage", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const libraryFile = yield* project.file("src/library.ts")
                const decls = yield* Query.match(
                  libraryFile,
                  Pattern.functionDeclaration({ exported: true }),
                ).pipe(Query.collect)
                return Draft.audit(decls)
              }),
          })

          const piped = Recipe.pipe(editStage, auditStage)
          const editPlan = yield* Recipe.run(editStage, undefined)
          const auditPlan = yield* Recipe.run(auditStage, undefined)
          const pipedPlan = yield* Recipe.run(piped, undefined)

          expect(auditPlan.edits).toHaveLength(0)
          expect(auditPlan.evidence.length).toBeGreaterThan(0)
          expect(editPlan.edits.length).toBeGreaterThan(0)
          expect(pipedPlan.edits.length).toBe(editPlan.edits.length)
          expect(pipedPlan.measurements?.matches).toBe(
            (editPlan.measurements?.matches ?? 0) + (auditPlan.measurements?.matches ?? 0),
          )
          const pipedEvidenceIds = new Set(pipedPlan.evidence.map((item) => item.id))
          for (const item of editPlan.evidence) {
            expect(pipedEvidenceIds.has(item.id)).toBe(true)
          }
          for (const item of auditPlan.evidence) {
            expect(pipedEvidenceIds.has(item.id)).toBe(true)
          }
        }),
      ),
    60_000,
  )

  effect(
    "Recipe.pipe deduplicates identical helper evidence when later stages edit the same range",
    () =>
      withFixture((_, app) =>
        Effect.gen(function* () {
          const bump = Recipe.define("bump-first-arg", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const calls = yield* Query.calls(project).pipe(
                  Query.within("src/consumer.ts"),
                  Query.withArgCount(1),
                  Query.collect,
                )
                const call = calls.find((selection) => selection.value.arguments[0] !== undefined)
                expect(call).toBeDefined()
                if (call === undefined) return Draft.empty
                return yield* Draft.args.wrap(project, call.value, 0, (text) => text)
              }),
          })
          const again = Recipe.define("wrap-same-arg-again", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const calls = yield* Query.calls(project).pipe(
                  Query.within("src/consumer.ts"),
                  Query.withArgCount(1),
                  Query.collect,
                )
                const call = calls.find((selection) => selection.value.arguments[0] !== undefined)
                expect(call).toBeDefined()
                if (call === undefined) return Draft.empty
                return yield* Draft.args.wrap(project, call.value, 0, (text) => text)
              }),
          })
          const plan = yield* Recipe.run(Recipe.pipe(bump, again), undefined)
          const wrapIds = plan.evidence.filter((item) => item.id.includes("argument:wrap"))
          expect(new Set(wrapIds.map((item) => item.id)).size).toBe(wrapIds.length)

          const conflictingA = Recipe.define("conflict-a", {
            version: "1.0.0",
            run: () =>
              Effect.succeed({
                edits: [],
                evidence: [{ id: "shared", kind: "file-operation", facts: { kind: "create" } }],
                matches: 1,
              }),
          })
          const conflictingB = Recipe.define("conflict-b", {
            version: "1.0.0",
            run: () =>
              Effect.succeed({
                edits: [],
                evidence: [{ id: "shared", kind: "file-operation", facts: { kind: "delete" } }],
                matches: 1,
              }),
          })
          const pipedConflict = yield* Recipe.run(
            Recipe.pipe(conflictingA, conflictingB),
            undefined,
          ).pipe(Effect.flip)
          expect(pipedConflict._tag).toBe("DraftEvidenceConflict")
          const allConflict = yield* Recipe.run(
            Recipe.all([conflictingA, conflictingB]),
            undefined,
          ).pipe(Effect.flip)
          expect(allConflict._tag).toBe("DraftEvidenceConflict")
        }),
      ),
    60_000,
  )
})
