import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as Application from "../Application/index.ts"
import * as Draft from "../Draft/index.ts"
import { applicationLayerNode } from "../Node/index.ts"
import * as Pattern from "../Pattern/index.ts"
import * as Policy from "../Policy/index.ts"
import * as Precondition from "../Precondition/index.ts"
import * as Query from "../Query/index.ts"
import { RecipeInputError } from "../Recipe/index.ts"
import * as Recipe from "../Recipe/index.ts"
import * as Verification from "../Verification/index.ts"
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("declarative transformations API (@effect/vitest)", () => {
  describe("recipe combinators & schema validation", () => {
    effect("validates recipe inputs with Effect Schema", () =>
      withFixture((_, _app) =>
        Effect.gen(function*() {
          const schemaRecipe = Recipe.define("schema-recipe", {
            version: "1.0.0",
            schema: Schema.Struct({
              propertyName: Schema.NonEmptyString,
              multiplier: Schema.Finite,
            }),
            run: (input) =>
              Effect.sync(() => {
                expect(input.propertyName).toBe("validProp")
                expect(input.multiplier).toBe(42)
                return Draft.empty
              }),
          })

          // Valid input passes
          yield* Recipe.run(schemaRecipe, { propertyName: "validProp", multiplier: 42 })

          // Invalid input fails with RecipeInputError
          const failure = yield* Recipe.run(schemaRecipe, { propertyName: "", multiplier: 42 } as any).pipe(
            Effect.flip,
          )
          expect(failure).toBeInstanceOf(RecipeInputError)
        })
      ),
      60_000,
    )

    effect("composes sequential recipes with Recipe.pipe and in-memory transitions", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const addImportRecipe = Recipe.define("add-import", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function*() {
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
              Effect.gen(function*() {
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
          yield* Application.apply(verified).pipe(
            Effect.provide(applicationLayerNode),
          )

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("TargetInput")
        })
      ),
      60_000,
    )

    effect("composes sequential recipes on the SAME file via Recipe.pipe without edit corruption", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const step1 = Recipe.define("step1-add-import", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function*() {
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
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const target = yield* project.symbolNamed("target", { within: "src/library.ts" })
                const calls = yield* Query.calls(project).pipe(
                  Query.within("src/consumer.ts"),
                  Query.where(Query.resolvesTo(target, { location: (c) => c.expression })),
                  Query.collect,
                )
                return yield* Draft.replaceEach(calls, ({ project: p, value: call }) =>
                  Draft.wrapArgument(p, call, 0, (arg) => `{ value: ${arg} }`)
                )
              }),
          })

          const piped = Recipe.pipe(step1, step2)
          const plan = yield* Recipe.run(piped, undefined)
          const verified = yield* Verification.verify(plan, piped, undefined)
          yield* Application.apply(verified).pipe(
            Effect.provide(applicationLayerNode),
          )

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("TargetInput")
          expect(consumerContent).toContain("renamed(/* keep this comment */ { value: 1 })")
        })
      ),
      60_000,
    )

    effect("two-phase scanning recipes (Recipe.scanning) build global accumulators in scan and transform in run", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
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
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const libraryFile = yield* project.file("src/library.ts")
                const fnDecls = yield* Query.match(libraryFile, Pattern.functionDeclaration({ exported: true })).pipe(
                  Query.collect,
                )

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
              Effect.gen(function*() {
                expect(exportMap.has("target")).toBe(true)
                expect(exportMap.get("target")?.paramCount).toBe(1)

                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const consumerFile = yield* project.file("src/consumer.ts")
                const targetSymbol = yield* project.symbolNamed("target", { within: "src/library.ts" })

                const calls = yield* Query.calls(consumerFile).pipe(
                  Query.where(Query.resolvesTo(targetSymbol, { location: (c) => c.expression })),
                  Query.collect,
                )

                return yield* Draft.replaceEach(calls, ({ project: p, value: call }) =>
                  Draft.wrapArgument(p, call, 0, (arg) => `/* scanned:${exportMap.get("target")?.name} */ ${arg}`)
                )
              }),
          })

          // Verify that scan can be invoked directly on the ScanningRecipe
          const directAcc = yield* Workspace.use((_ws) =>
            Effect.gen(function*() {
              const workspace = yield* Workspace
              return yield* workspace.withSnapshot({}, Effect.gen(function*() {
                return yield* scanningRecipe.scan(undefined)
              }))
            })
          )
          expect(directAcc.has("target")).toBe(true)

          // Run end-to-end plan, verify and apply
          const plan = yield* Recipe.run(scanningRecipe, undefined)
          expect(plan.edits.length).toBeGreaterThanOrEqual(1)

          const verified = yield* Verification.verify(plan, scanningRecipe, undefined)
          yield* Application.apply(verified).pipe(
            Effect.provide(applicationLayerNode),
          )

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("/* scanned:target */ 1")
        })
      ),
      60_000,
    )

    effect("two-phase scanning recipes support Schema-validated inputs and pipe composition", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const InputSchema = Schema.Struct({
            importName: Schema.NonEmptyString,
          })

          const scanningWithInput = Recipe.scanning("scan-with-input", {
            version: "1.0.0",
            schema: InputSchema,
            scan: (_input) =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const count = (yield* project.sourceFileNames).length
                return { count, sourceModule: "./library.js" }
              }),
            run: (acc, input) =>
              Effect.gen(function*() {
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

          const verified = yield* Verification.verify(plan, scanningWithInput, { importName: "TargetInput" })
          yield* Application.apply(verified).pipe(
            Effect.provide(applicationLayerNode),
          )

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("TargetInput")
        })
      ),
      60_000,
    )

    effect("two-phase scanning recipes compose cleanly in Recipe.pipe", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const step1Scan = Recipe.scanning("step1-scan-and-import", {
            version: "1.0.0",
            scan: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const libraryFile = yield* project.file("src/library.ts")
                const text = yield* libraryFile.sourceText
                const hasTarget = text.includes("export function target")
                return { hasTarget }
              }),
            run: (acc) =>
              Effect.gen(function*() {
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
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const target = yield* project.symbolNamed("target", { within: "src/library.ts" })
                const calls = yield* Query.calls(project).pipe(
                  Query.within("src/consumer.ts"),
                  Query.where(Query.resolvesTo(target, { location: (c) => c.expression })),
                  Query.collect,
                )
                return yield* Draft.replaceEach(calls, ({ project: p, value: call }) =>
                  Draft.wrapArgument(p, call, 0, (arg) => `{ value: ${arg} }`)
                )
              }),
          })

          const piped = Recipe.pipe(step1Scan, step2Regular)
          const plan = yield* Recipe.run(piped, undefined)
          expect(plan.edits.length).toBeGreaterThanOrEqual(1)

          const verified = yield* Verification.verify(plan, piped, undefined)
          yield* Application.apply(verified).pipe(
            Effect.provide(applicationLayerNode),
          )

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("TargetInput")
          expect(consumerContent).toContain("renamed(/* keep this comment */ { value: 1 })")
        })
      ),
      60_000,
    )

    effect("Draft.renameSymbolNamed provides idempotent symbol renaming by name", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const renameRecipe = Recipe.define("rename-by-name", {
            version: "1.0.0",
            policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.renameSymbolNamed(project, "target", "newTarget", {
                  within: "src/library.ts",
                })
              }),
          })

          const plan = yield* Recipe.run(renameRecipe, undefined)
          const verified = yield* Verification.verify(plan, renameRecipe, undefined)
          yield* Application.apply(verified).pipe(
            Effect.provide(applicationLayerNode),
          )

          const libContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/library.ts"), "utf8")
          )
          expect(libContent).toContain("export function newTarget")
        })
      ),
      60_000,
    )

    effect("supports validated ProjectFile handles with fail-fast lookup and scoped operations", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const fileRecipe = Recipe.define("use-project-file", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)

                // 1. Validated file lookup (fails fast with FileNotFound if missing)
                const consumerFile = yield* project.file("src/consumer.ts")
                expect(consumerFile.path).toBe("src/consumer.ts")

                // 2. Optional file lookup
                const maybeFile = yield* project.findFile("src/nonexistent.ts")
                expect(maybeFile._tag).toBe("None")

                // 3. Scoped symbol lookup from file
                const libraryFile = yield* project.file("src/library.ts")
                const targetSymbol = yield* libraryFile.symbolNamed("target")
                expect(targetSymbol.name).toBe("target")

                // 4. Scoped query directly on ProjectFile
                const callsInConsumer = yield* Query.calls(consumerFile).pipe(
                  Query.where(Query.resolvesTo(targetSymbol, { location: (c) => c.expression })),
                  Query.collect,
                )
                expect(callsInConsumer.length).toBe(1)

                // 5. Scoped import addition on ProjectFile
                const importDraft = yield* Draft.imports.addNamed(consumerFile, {
                  module: "./library.js",
                  name: "TargetInput",
                })

                // 6. Scoped argument replacement
                const replaceDraft = yield* Draft.replaceEach(callsInConsumer, ({ project: p, value: call }) =>
                  Draft.wrapArgument(p, call, 0, (arg) => `{ value: ${arg} }`)
                )

                return Draft.concat(importDraft, replaceDraft)
              }),
          })

          const plan = yield* Recipe.run(fileRecipe, undefined)
          const verified = yield* Verification.verify(plan, fileRecipe, undefined)
          yield* Application.apply(verified).pipe(
            Effect.provide(applicationLayerNode),
          )

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("TargetInput")
          expect(consumerContent).toContain("renamed(/* keep this comment */ { value: 1 })")
        })
      ),
      60_000,
    )

    effect("ProjectFile navigation resolves direct and transitive referencing/referenced file graphs", () =>
      withFixture((_root, app) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot({}, Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)

            const libraryFile = yield* project.file("src/library.ts")
            const barrelFile = yield* project.file("src/barrel.ts")
            const consumerFile = yield* project.file("src/consumer.ts")
            const reexportConsumerFile = yield* project.file("src/reexport-consumer.ts")

            // Direct referencing files (downstream dependents/importers)
            const libraryDirectReferencing = yield* libraryFile.referencingFiles()
            expect(libraryDirectReferencing.map((f) => f.path)).toEqual([
              "src/barrel.ts",
              "src/consumer.ts",
            ])

            const barrelDirectReferencing = yield* barrelFile.referencingFiles()
            expect(barrelDirectReferencing.map((f) => f.path)).toEqual([
              "src/reexport-consumer.ts",
            ])

            // Transitive referencing files (through barrels / re-exports)
            const libraryTransitiveReferencing = yield* libraryFile.referencingFiles({ transitive: true })
            expect(libraryTransitiveReferencing.map((f) => f.path)).toEqual([
              "src/barrel.ts",
              "src/consumer.ts",
              "src/reexport-consumer.ts",
            ])

            // Direct referenced files (upstream dependencies)
            const reexportDirectReferenced = yield* reexportConsumerFile.referencedFiles()
            expect(reexportDirectReferenced.map((f) => f.path)).toEqual([
              "src/barrel.ts",
            ])

            const consumerDirectReferenced = yield* consumerFile.referencedFiles()
            expect(consumerDirectReferenced.map((f) => f.path)).toEqual([
              "src/library.ts",
            ])

            // Transitive referenced files
            const reexportTransitiveReferenced = yield* reexportConsumerFile.referencedFiles({ transitive: true })
            expect(reexportTransitiveReferenced.map((f) => f.path)).toEqual([
              "src/barrel.ts",
              "src/library.ts",
            ])

            // Querying directly over the dependency slice: ReadonlyArray<ProjectFile>
            const targetSymbol = yield* libraryFile.symbolNamed("target")
            const callsInSlice = yield* Query.calls(libraryDirectReferencing).pipe(
              Query.where(Query.resolvesTo(targetSymbol, { location: (c) => c.expression })),
              Query.collect,
            )
            expect(callsInSlice.length).toBe(1)
            expect(callsInSlice[0]?.fileName).toBe("src/consumer.ts")

            // Empty ProjectScope slice should return empty stream without erroring
            const emptyCalls = yield* Query.calls([]).pipe(Query.collect)
            expect(emptyCalls).toEqual([])

            // Match query on a slice
            const fnDeclsInSlice = yield* Query.match(
              [libraryFile, consumerFile],
              Pattern.functionDeclaration({ exported: true }),
            ).pipe(Query.collect)
            expect(fnDeclsInSlice.length).toBe(2)
            expect(fnDeclsInSlice.map((d) => d.fileName)).toEqual(["src/library.ts", "src/library.ts"])

            // Deduplication when duplicate ProjectFiles are passed into Query
            const callsWithDuplicates = yield* Query.calls([consumerFile, consumerFile]).pipe(
              Query.where(Query.resolvesTo(targetSymbol, { location: (c) => c.expression })),
              Query.collect,
            )
            expect(callsWithDuplicates.length).toBe(1)
          }))
        })
      ),
      60_000,
    )

    effect("ProjectFile navigation handles circular dependencies safely with cycle protection", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          // Add a circular import: library.ts imports consumer.ts while consumer.ts imports library.ts
          yield* Effect.tryPromise(() =>
            Fs.writeFile(
              Path.join(root, "src/library.ts"),
              `import "./consumer.js"\nexport function target(input: number): number { return input + 1 }\n`,
              "utf8",
            )
          )

          const workspace = yield* Workspace
          yield* workspace.withSnapshot({}, Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)

            const libraryFile = yield* project.file("src/library.ts")
            const consumerFile = yield* project.file("src/consumer.ts")

            // Direct referencing
            const libReferencing = yield* libraryFile.referencingFiles()
            expect(libReferencing.map((f) => f.path)).toContain("src/consumer.ts")

            const consumerReferencing = yield* consumerFile.referencingFiles()
            expect(consumerReferencing.map((f) => f.path)).toContain("src/library.ts")

            // Transitive referencing with cycle (A -> B -> A): should terminate and exclude the source file itself
            const libTransitive = yield* libraryFile.referencingFiles({ transitive: true })
            expect(libTransitive.map((f) => f.path)).not.toContain("src/library.ts")
            expect(libTransitive.map((f) => f.path)).toContain("src/consumer.ts")

            const consumerTransitive = yield* consumerFile.referencingFiles({ transitive: true })
            expect(consumerTransitive.map((f) => f.path)).not.toContain("src/consumer.ts")
            expect(consumerTransitive.map((f) => f.path)).toContain("src/library.ts")

            // Transitive referenced with cycle
            const libTransitiveReferenced = yield* libraryFile.referencedFiles({ transitive: true })
            expect(libTransitiveReferenced.map((f) => f.path)).not.toContain("src/library.ts")
            expect(libTransitiveReferenced.map((f) => f.path)).toContain("src/consumer.ts")
          }))
        })
      ),
      60_000,
    )

    effect("Precondition fast file-level filters and combinators narrow query candidate sets", () =>
      withFixture((_root, app) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot({}, Effect.gen(function*() {
            const snapshot = yield* WorkspaceSnapshot
            const project = yield* snapshot.project(app)

            const libraryFile = yield* project.file("src/library.ts")
            const consumerFile = yield* project.file("src/consumer.ts")
            const barrelFile = yield* project.file("src/barrel.ts")
            yield* project.file("src/reexport-consumer.ts")

            // 1. fileTextIncludes
            const hasSentinels = yield* Precondition.satisfies(
              consumerFile,
              Precondition.fileTextIncludes("renamed"),
            )
            expect(hasSentinels).toBe(true)

            const libraryHasSentinel = yield* Precondition.satisfies(
              libraryFile,
              Precondition.fileTextIncludes("renamed"),
            )
            expect(libraryHasSentinel).toBe(false)

            // 2. fileTextMatches (including stateful /g regex evaluated concurrently)
            const globalRegex = /export\s+const\s+(\w+)/g
            const constMatches = yield* Precondition.filesMatching(
              project,
              Precondition.fileTextMatches(globalRegex),
            )
            expect(constMatches.map((f) => f.path)).toEqual([
              "src/consumer.ts",
              "src/reexport-consumer.ts",
            ])

            // 3. hasImport (static imports, re-exports, regex module specifier)
            const libraryImporters = yield* Precondition.filesMatching(
              project,
              Precondition.hasImport("./library.js"),
            )
            expect(libraryImporters.map((f) => f.path)).toEqual([
              "src/barrel.ts",
              "src/consumer.ts",
            ])

            const barrelImporters = yield* Precondition.filesMatching(
              project,
              Precondition.hasImport("./barrel.js"),
            )
            expect(barrelImporters.map((f) => f.path)).toEqual([
              "src/reexport-consumer.ts",
            ])

            const regexImporters = yield* Precondition.filesMatching(
              project,
              Precondition.hasImport(/library/),
            )
            expect(regexImporters.map((f) => f.path)).toEqual([
              "src/barrel.ts",
              "src/consumer.ts",
            ])

            const nonExistentImporters = yield* Precondition.filesMatching(
              project,
              Precondition.hasImport("@nonexistent/package"),
            )
            expect(nonExistentImporters).toEqual([])

            // 4. pathMatches (exact, glob, substring, regex)
            const exactPath = yield* Precondition.filesMatching(
              project,
              Precondition.pathMatches("src/consumer.ts"),
            )
            expect(exactPath.map((f) => f.path)).toEqual(["src/consumer.ts"])

            const globPath = yield* Precondition.filesMatching(
              project,
              Precondition.pathMatches("src/*.ts"),
            )
            expect(globPath.map((f) => f.path)).toEqual([
              "src/barrel.ts",
              "src/consumer.ts",
              "src/library.ts",
              "src/reexport-consumer.ts",
            ])

            const regexPath = yield* Precondition.filesMatching(
              project,
              Precondition.pathMatches(/reexport/),
            )
            expect(regexPath.map((f) => f.path)).toEqual(["src/reexport-consumer.ts"])

            // 5. Combinators: all, any, not, custom
            const allMatch = yield* Precondition.filesMatching(
              project,
              Precondition.all(
                Precondition.pathMatches(/consumer/),
                Precondition.hasImport("./library.js"),
              ),
            )
            expect(allMatch.map((f) => f.path)).toEqual(["src/consumer.ts"])

            const anyMatch = yield* Precondition.filesMatching(
              project,
              Precondition.any(
                Precondition.pathMatches("src/barrel.ts"),
                Precondition.pathMatches("src/consumer.ts"),
              ),
            )
            expect(anyMatch.map((f) => f.path)).toEqual([
              "src/barrel.ts",
              "src/consumer.ts",
            ])

            const notBarrel = yield* Precondition.filesMatching(
              [barrelFile, consumerFile],
              Precondition.not(Precondition.pathMatches("src/barrel.ts")),
            )
            expect(notBarrel.map((f) => f.path)).toEqual(["src/consumer.ts"])

            const customCondition = Precondition.custom("contains-other", (f) =>
              f.sourceText.pipe(
                Effect.map((text) => text.includes("other")),
                Effect.catchTag("FileNotFound", () => Effect.succeed(false)),
              )
            )
            const customMatched = yield* Precondition.filesMatching(project, customCondition)
            expect(customMatched.map((f) => f.path)).toEqual([
              "src/consumer.ts",
              "src/library.ts",
            ])

            // 6. Running Query.calls scoped to pre-filtered files
            const targetSymbol = yield* libraryFile.symbolNamed("target")
            const filteredFiles = yield* Precondition.filesMatching(
              project,
              Precondition.all(
                Precondition.hasImport("./library.js"),
                Precondition.fileTextIncludes("renamed"),
              ),
            )
            expect(filteredFiles.map((f) => f.path)).toEqual(["src/consumer.ts"])

            const callsInFiltered = yield* Query.calls(filteredFiles).pipe(
              Query.where(Query.resolvesTo(targetSymbol, { location: (c) => c.expression })),
              Query.collect,
            )
            expect(callsInFiltered.length).toBe(1)
            expect(callsInFiltered[0]?.fileName).toBe("src/consumer.ts")
          }))
        })
      ),
      60_000,
    )

    effect("Preconditions respect Recipe.pipe overlays when evaluating chained transformations", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          // Recipe 1: Adds import of publicTarget from ./barrel.js to consumer.ts
          const step1 = Recipe.define("step1-add-barrel-import", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function*() {
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
              Effect.gen(function*() {
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
                  Draft.wrapArgument(p, call, 0, (arg) => `publicTarget(${arg})`)
                )
              }),
          })

          const pipeline = Recipe.pipe(step1, step2)
          const plan = yield* Recipe.run(pipeline, undefined)
          const verified = yield* Verification.verify(plan, pipeline, undefined)
          yield* Application.apply(verified).pipe(
            Effect.provide(applicationLayerNode),
          )

          const consumerContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/consumer.ts"), "utf8")
          )
          expect(consumerContent).toContain("publicTarget")
          expect(consumerContent).toContain("renamed(/* keep this comment */ publicTarget(1))")
        })
      ),
      60_000,
    )

    effect("composes concurrent recipes with Recipe.all and executes conditionally with Recipe.branch", () =>
      withFixture((_, app) =>
        Effect.gen(function*() {
          const recipeA = Recipe.define("recipe-a", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function*() {
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
              Effect.gen(function*() {
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
        })
      ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 4. High-Fidelity Syntactic Draft Combinators & Symbol Rename
})
