import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as Application from "../Application/index.ts"
import * as Draft from "../Draft/index.ts"
import { applicationLayerNode } from "../Node/index.ts"
import * as Pattern from "../Pattern/index.ts"
import * as Policy from "../Policy/index.ts"
import * as Query from "../Query/index.ts"
import * as Recipe from "../Recipe/index.ts"
import * as Verification from "../Verification/index.ts"
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("recipe sequential composition", () => {
  effect(
    "composes sequential recipes with Recipe.pipe and in-memory transitions",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          const addImportRecipe = Recipe.define("add-import", {
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

          const addSecondImportRecipe = Recipe.define("add-second-import", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.imports.addNamed(project, "src/reexport-consumer.ts", {
                  module: "./library.js",
                  name: "TargetInput",
                })
              }),
          })

          const pipedRecipe = Recipe.pipe(addImportRecipe, addSecondImportRecipe)

          const plan = yield* Recipe.run(pipedRecipe, undefined)
          expect(plan.edits.length).toBeGreaterThanOrEqual(2)

          const verified = yield* Verification.verify(plan, pipedRecipe, undefined)
          yield* Application.apply(verified).pipe(Effect.provide(applicationLayerNode))

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
          )
          expect(consumerContent).toContain("TargetInput")
        }),
      ),
    60_000,
  )

  effect(
    "composes sequential recipes on the SAME file via Recipe.pipe without edit corruption",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          const step1 = Recipe.define("step1-add-import", {
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

          const step2 = Recipe.define("step2-wrap-arg", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const target = yield* project.symbolNamed("target", { within: "src/library.ts" })
                const calls = yield* Query.calls(project).pipe(
                  Query.within("src/consumer.ts"),
                  Query.where(Query.resolvesTo(target, { location: (c) => c.expression })),
                  Query.collect,
                )
                return yield* Draft.replaceEach(calls, ({ project: p, value: call }) =>
                  Draft.wrapArgument(p, call, 0, (arg) => `{ value: ${arg} }`),
                )
              }),
          })

          const piped = Recipe.pipe(step1, step2)
          const plan = yield* Recipe.run(piped, undefined)
          const verified = yield* Verification.verify(plan, piped, undefined)
          yield* Application.apply(verified).pipe(Effect.provide(applicationLayerNode))

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
          )
          expect(consumerContent).toContain("TargetInput")
          expect(consumerContent).toContain("renamed(/* keep this comment */ { value: 1 })")
        }),
      ),
    60_000,
  )

  effect(
    "two-phase scanning recipes (Recipe.scanning) build global accumulators in scan and transform in run",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          interface ExportInfo {
            readonly name: string
            readonly paramCount: number
          }

          // Define a scanning recipe:
          // Phase 1 (scan): Scan library.ts and collect all exported functions into a Map
          // Phase 2 (run): Use the accumulator map to rewrite call sites in consumer.ts
          const scanningRecipe = Recipe.scanning("scan-and-migrate-calls", {
            version: "1.0.0",
            policies: [Policy.matches({ min: 1 }), Policy.noNewErrors()],
            scan: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const libraryFile = yield* project.file("src/library.ts")
                const fnDecls = yield* Query.match(
                  libraryFile,
                  Pattern.functionDeclaration({ exported: true }),
                ).pipe(Query.collect)

                const exportMap = new Map<string, ExportInfo>()
                for (const sel of fnDecls) {
                  if (sel.value.name !== undefined) {
                    exportMap.set(sel.value.name.text, {
                      name: sel.value.name.text,
                      paramCount: sel.value.parameters.length,
                    })
                  }
                }
                return exportMap
              }),
            run: (exportMap) =>
              Effect.gen(function* () {
                expect(exportMap.has("target")).toBe(true)
                expect(exportMap.get("target")?.paramCount).toBe(1)

                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const consumerFile = yield* project.file("src/consumer.ts")
                const targetSymbol = yield* project.symbolNamed("target", {
                  within: "src/library.ts",
                })

                const calls = yield* Query.calls(consumerFile).pipe(
                  Query.where(Query.resolvesTo(targetSymbol, { location: (c) => c.expression })),
                  Query.collect,
                )

                return yield* Draft.replaceEach(calls, ({ project: p, value: call }) =>
                  Draft.wrapArgument(
                    p,
                    call,
                    0,
                    (arg) => `/* scanned:${exportMap.get("target")?.name} */ ${arg}`,
                  ),
                )
              }),
          })

          // Verify that scan can be invoked directly on the ScanningRecipe
          const directAcc = yield* Workspace.use((_ws) =>
            Effect.gen(function* () {
              const workspace = yield* Workspace
              return yield* workspace.withSnapshot({}, scanningRecipe.scan(undefined))
            }),
          )
          expect(directAcc.has("target")).toBe(true)

          // Run end-to-end plan, verify and apply
          const plan = yield* Recipe.run(scanningRecipe, undefined)
          expect(plan.edits.length).toBeGreaterThanOrEqual(1)

          const verified = yield* Verification.verify(plan, scanningRecipe, undefined)
          yield* Application.apply(verified).pipe(Effect.provide(applicationLayerNode))

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
          )
          expect(consumerContent).toContain("/* scanned:target */ 1")
        }),
      ),
    60_000,
  )

  effect(
    "two-phase scanning recipes support Schema-validated inputs and pipe composition",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          const InputSchema = Schema.Struct({
            importName: Schema.NonEmptyString,
          })

          const scanningWithInput = Recipe.scanning("scan-with-input", {
            version: "1.0.0",
            schema: InputSchema,
            scan: (_input) =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const count = (yield* project.sourceFileNames).length
                return { count, sourceModule: "./library.js" }
              }),
            run: (acc, input) =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
                  module: acc.sourceModule,
                  name: input.importName,
                })
              }),
          })

          const plan = yield* Recipe.run(scanningWithInput, { importName: "TargetInput" })
          expect(plan.edits.length).toBe(1)

          const verified = yield* Verification.verify(plan, scanningWithInput, {
            importName: "TargetInput",
          })
          yield* Application.apply(verified).pipe(Effect.provide(applicationLayerNode))

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
          )
          expect(consumerContent).toContain("TargetInput")
        }),
      ),
    60_000,
  )

  effect(
    "two-phase scanning recipes compose cleanly in Recipe.pipe",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          const step1Scan = Recipe.scanning("step1-scan-and-import", {
            version: "1.0.0",
            scan: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const libraryFile = yield* project.file("src/library.ts")
                const text = yield* libraryFile.sourceText
                const hasTarget = text.includes("export function target")
                return { hasTarget }
              }),
            run: (acc) =>
              Effect.gen(function* () {
                if (!acc.hasTarget) return Draft.empty
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.imports.addNamed(project, "src/consumer.ts", {
                  module: "./library.js",
                  name: "TargetInput",
                })
              }),
          })

          const step2Regular = Recipe.define("step2-wrap-arg", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const target = yield* project.symbolNamed("target", { within: "src/library.ts" })
                const calls = yield* Query.calls(project).pipe(
                  Query.within("src/consumer.ts"),
                  Query.where(Query.resolvesTo(target, { location: (c) => c.expression })),
                  Query.collect,
                )
                return yield* Draft.replaceEach(calls, ({ project: p, value: call }) =>
                  Draft.wrapArgument(p, call, 0, (arg) => `{ value: ${arg} }`),
                )
              }),
          })

          const piped = Recipe.pipe(step1Scan, step2Regular)
          const plan = yield* Recipe.run(piped, undefined)
          expect(plan.edits.length).toBeGreaterThanOrEqual(1)

          const verified = yield* Verification.verify(plan, piped, undefined)
          yield* Application.apply(verified).pipe(Effect.provide(applicationLayerNode))

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8"),
          )
          expect(consumerContent).toContain("TargetInput")
          expect(consumerContent).toContain("renamed(/* keep this comment */ { value: 1 })")
        }),
      ),
    60_000,
  )
})
