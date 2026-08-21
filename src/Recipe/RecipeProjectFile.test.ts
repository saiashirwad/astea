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
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("recipe project-file composition", () => {
  effect(
    "Draft.renameSymbolNamed provides idempotent symbol renaming by name",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          const renameRecipe = Recipe.define("rename-by-name", {
            version: "1.0.0",
            policies: [Policy.matches({ min: 1 }), Policy.noNewErrors(), Policy.idempotent()],
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                return yield* Draft.renameSymbolNamed(project, "target", "newTarget", {
                  lookupIn: "src/library.ts",
                })
              }),
          })

          const plan = yield* Recipe.run(renameRecipe, undefined)
          const verified = yield* Verification.verify(plan, renameRecipe, undefined)
          yield* Application.apply(verified).pipe(Effect.provide(applicationLayerNode))

          const libContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/library.ts"), "utf8"),
          )
          expect(libContent).toContain("export function newTarget")
        }),
      ),
    60_000,
  )

  effect(
    "supports validated ProjectFile handles with fail-fast lookup and scoped operations",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          const fileRecipe = Recipe.define("use-project-file", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)

                const consumerFile = yield* project.file("src/consumer.ts")
                expect(consumerFile.path).toBe("src/consumer.ts")

                const maybeFile = yield* project.findFile("src/nonexistent.ts")
                expect(maybeFile._tag).toBe("None")

                const libraryFile = yield* project.file("src/library.ts")
                const targetSymbol = yield* libraryFile.symbolNamed("target")
                expect(targetSymbol.name).toBe("target")

                const callsInConsumer = yield* Query.calls(consumerFile).pipe(
                  Query.where(Query.resolvesTo(targetSymbol, { location: (c) => c.expression })),
                  Query.collect,
                )
                expect(callsInConsumer.length).toBe(1)

                const importDraft = yield* Draft.imports.addNamed(consumerFile, {
                  module: "./library.js",
                  name: "TargetInput",
                })

                const replaceDraft = yield* Draft.replaceEach(
                  callsInConsumer,
                  ({ value: call }) => {
                    const arg = call.arguments[0]!
                    return { node: arg, text: `{ value: ${arg.getText()} }` }
                  },
                )

                return Draft.concat(importDraft, replaceDraft)
              }),
          })

          const plan = yield* Recipe.run(fileRecipe, undefined)
          const verified = yield* Verification.verify(plan, fileRecipe, undefined)
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
    "ProjectFile navigation resolves direct and transitive referencing/referenced file graphs",
    () =>
      withFixture((_root, app) =>
        Effect.gen(function* () {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot(
            {},
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)

              const libraryFile = yield* project.file("src/library.ts")
              const barrelFile = yield* project.file("src/barrel.ts")
              const consumerFile = yield* project.file("src/consumer.ts")
              const reexportConsumerFile = yield* project.file("src/reexport-consumer.ts")

              const libraryDirectReferencing = yield* libraryFile.referencingFiles()
              expect(libraryDirectReferencing.map((f) => f.path)).toEqual([
                "src/barrel.ts",
                "src/consumer.ts",
              ])

              const barrelDirectReferencing = yield* barrelFile.referencingFiles()
              expect(barrelDirectReferencing.map((f) => f.path)).toEqual([
                "src/reexport-consumer.ts",
              ])

              const libraryTransitiveReferencing = yield* libraryFile.referencingFiles({
                transitive: true,
              })
              expect(libraryTransitiveReferencing.map((f) => f.path)).toEqual([
                "src/barrel.ts",
                "src/consumer.ts",
                "src/reexport-consumer.ts",
              ])

              const reexportDirectReferenced = yield* reexportConsumerFile.referencedFiles()
              expect(reexportDirectReferenced.map((f) => f.path)).toEqual(["src/barrel.ts"])

              const consumerDirectReferenced = yield* consumerFile.referencedFiles()
              expect(consumerDirectReferenced.map((f) => f.path)).toEqual(["src/library.ts"])

              const reexportTransitiveReferenced = yield* reexportConsumerFile.referencedFiles({
                transitive: true,
              })
              expect(reexportTransitiveReferenced.map((f) => f.path)).toEqual([
                "src/barrel.ts",
                "src/library.ts",
              ])

              const targetSymbol = yield* libraryFile.symbolNamed("target")
              const callsInSlice = yield* Query.calls(libraryDirectReferencing).pipe(
                Query.where(Query.resolvesTo(targetSymbol, { location: (c) => c.expression })),
                Query.collect,
              )
              expect(callsInSlice.length).toBe(1)
              expect(callsInSlice[0]?.fileName).toBe("src/consumer.ts")

              const emptyCalls = yield* Query.calls([]).pipe(Query.collect)
              expect(emptyCalls).toEqual([])

              const fnDeclsInSlice = yield* Query.match(
                [libraryFile, consumerFile],
                Pattern.functionDeclaration({ exported: true }),
              ).pipe(Query.collect)
              expect(fnDeclsInSlice.length).toBe(2)
              expect(fnDeclsInSlice.map((d) => d.fileName)).toEqual([
                "src/library.ts",
                "src/library.ts",
              ])

              const callsWithDuplicates = yield* Query.calls([consumerFile, consumerFile]).pipe(
                Query.where(Query.resolvesTo(targetSymbol, { location: (c) => c.expression })),
                Query.collect,
              )
              expect(callsWithDuplicates.length).toBe(1)
            }),
          )
        }),
      ),
    60_000,
  )

  effect(
    "ProjectFile navigation handles circular dependencies safely with cycle protection",
    () =>
      withFixture((root, app) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            Fs.writeFile(
              Path.join(root, "src/library.ts"),
              `import "./consumer.js"\nexport function target(input: number): number { return input + 1 }\n`,
              "utf8",
            ),
          )

          const workspace = yield* Workspace
          yield* workspace.withSnapshot(
            {},
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)

              const libraryFile = yield* project.file("src/library.ts")
              const consumerFile = yield* project.file("src/consumer.ts")

              const libReferencing = yield* libraryFile.referencingFiles()
              expect(libReferencing.map((f) => f.path)).toContain("src/consumer.ts")

              const consumerReferencing = yield* consumerFile.referencingFiles()
              expect(consumerReferencing.map((f) => f.path)).toContain("src/library.ts")

              const libTransitive = yield* libraryFile.referencingFiles({ transitive: true })
              expect(libTransitive.map((f) => f.path)).not.toContain("src/library.ts")
              expect(libTransitive.map((f) => f.path)).toContain("src/consumer.ts")

              const consumerTransitive = yield* consumerFile.referencingFiles({
                transitive: true,
              })
              expect(consumerTransitive.map((f) => f.path)).not.toContain("src/consumer.ts")
              expect(consumerTransitive.map((f) => f.path)).toContain("src/library.ts")

              const libTransitiveReferenced = yield* libraryFile.referencedFiles({
                transitive: true,
              })
              expect(libTransitiveReferenced.map((f) => f.path)).not.toContain("src/library.ts")
              expect(libTransitiveReferenced.map((f) => f.path)).toContain("src/consumer.ts")
            }),
          )
        }),
      ),
    60_000,
  )

  effect(
    "Precondition fast file-level filters and combinators narrow query candidate sets",
    () =>
      withFixture((_root, app) =>
        Effect.gen(function* () {
          const workspace = yield* Workspace
          yield* workspace.withSnapshot(
            {},
            Effect.gen(function* () {
              const snapshot = yield* WorkspaceSnapshot
              const project = yield* snapshot.project(app)

              const libraryFile = yield* project.file("src/library.ts")
              const consumerFile = yield* project.file("src/consumer.ts")
              const barrelFile = yield* project.file("src/barrel.ts")
              yield* project.file("src/reexport-consumer.ts")

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

              const globalRegex = /export\s+const\s+(\w+)/g
              const constMatches = yield* Precondition.filesMatching(
                project,
                Precondition.fileTextMatches(globalRegex),
              )
              expect(constMatches.map((f) => f.path)).toEqual([
                "src/consumer.ts",
                "src/reexport-consumer.ts",
              ])

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
              expect(barrelImporters.map((f) => f.path)).toEqual(["src/reexport-consumer.ts"])

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
              expect(anyMatch.map((f) => f.path)).toEqual(["src/barrel.ts", "src/consumer.ts"])

              const notBarrel = yield* Precondition.filesMatching(
                [barrelFile, consumerFile],
                Precondition.not(Precondition.pathMatches("src/barrel.ts")),
              )
              expect(notBarrel.map((f) => f.path)).toEqual(["src/consumer.ts"])

              const customCondition = Precondition.custom("contains-other", (f) =>
                f.sourceText.pipe(
                  Effect.map((text) => text.includes("other")),
                  Effect.catchTag("FileNotFound", () => Effect.succeed(false)),
                ),
              )
              const customMatched = yield* Precondition.filesMatching(project, customCondition)
              expect(customMatched.map((f) => f.path)).toEqual([
                "src/consumer.ts",
                "src/library.ts",
              ])

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
            }),
          )
        }),
      ),
    60_000,
  )
})
