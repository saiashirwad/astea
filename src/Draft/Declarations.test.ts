import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as Application from "../Application/index.ts"
import * as Draft from "../Draft/index.ts"
import { applyFileEdits } from "../Edit/index.ts"
import { applicationLayerNode } from "../Node/index.ts"
import * as Recipe from "../Recipe/index.ts"
import * as Verification from "../Verification/index.ts"
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import { isFunctionDeclaration, isInterfaceDeclaration } from "typescript/unstable/ast/is"
import { withFixture } from "../test/declarative-fixture.ts"

describe("declarative transformations API (@effect/vitest)", () => {
  describe("declaration combinators", () => {
    effect(
      "modifies interfaces, classes, and function signatures with high-fidelity combinators",
      () =>
        withFixture((root, app) =>
          Effect.gen(function* () {
            const mainLayer = applicationLayerNode.pipe(
              Layer.provideMerge(Layer.succeed(Workspace, yield* Workspace)),
            )

            const declRecipe = Recipe.define("declaration-combinators-test", {
              version: "1.0.0",
              run: () =>
                Effect.gen(function* () {
                  const snapshot = yield* WorkspaceSnapshot
                  const project = yield* snapshot.project(app)

                  // 1. Create a class file
                  const classFileDraft = yield* Draft.files.create(
                    project,
                    "src/service.ts",
                    'export interface User { readonly id: string }\n\nexport class UserService {\n  public readonly endpoint: string = "/api/users";\n  public async getUser(id: string): Promise<User> {\n    return fetch(`${this.endpoint}/${id}`).then(r => r.json());\n  }\n}\n',
                  )

                  const lib = yield* project.sourceFile("src/library.ts")
                  let libAccumulated = Draft.empty
                  if (lib !== undefined) {
                    for (const statement of lib.statements) {
                      // Interface combinators
                      if (
                        isInterfaceDeclaration(statement) &&
                        statement.name.text === "TargetInput"
                      ) {
                        const d1 = yield* Draft.interfaces.addProperty(project, statement, {
                          name: "optionalFlag",
                          type: "boolean",
                          optional: true,
                        })
                        libAccumulated = Draft.concat(libAccumulated, d1)
                      }

                      // Function combinators
                      if (isFunctionDeclaration(statement) && statement.name?.text === "other") {
                        const d2 = yield* Draft.functions.addParameter(project, statement, {
                          name: "tag",
                          type: "string",
                          optional: true,
                        })
                        const d3 = yield* Draft.functions.setReturnType(
                          project,
                          statement,
                          "number",
                        )
                        libAccumulated = Draft.concat(libAccumulated, d2, d3)
                      }
                    }
                  }

                  return Draft.concat(classFileDraft, libAccumulated)
                }),
            })

            const plan = yield* Recipe.run(declRecipe, undefined)
            expect(plan.edits.length).toBeGreaterThanOrEqual(2)

            const verified = yield* Verification.verify(plan, declRecipe, undefined)
            yield* Application.apply(verified).pipe(Effect.provide(mainLayer))

            const libContent = yield* Effect.tryPromise(() =>
              Fs.readFile(Path.join(root, "src/library.ts"), "utf8"),
            )
            expect(libContent).toContain("optionalFlag?: boolean;")
            expect(libContent).toContain("function other(value: number, tag?: string): number")

            const serviceContent = yield* Effect.tryPromise(() =>
              Fs.readFile(Path.join(root, "src/service.ts"), "utf8"),
            )
            expect(serviceContent).toContain('public readonly endpoint: string = "/api/users";')
            expect(serviceContent).toContain("public async getUser(id: string): Promise<User>")
          }),
        ),
      60_000,
    )
    effect(
      "anchors function edits at AST parameter-list boundaries",
      () =>
        withFixture((root, app) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise(() =>
              Fs.writeFile(
                Path.join(root, "src/signatures.ts"),
                [
                  "export function handleEvent<T extends (evt: Event) => void>(callback: T) {}",
                  "export function empty<T extends (evt: Event) => void>() {}",
                  "",
                ].join("\n"),
              ),
            )
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const source = yield* project.sourceFile("src/signatures.ts")
                expect(source).toBeDefined()
                if (source === undefined) return
                const handleEvent = source.statements[0]
                const empty = source.statements[1]
                if (!handleEvent || !empty) return
                if (!isFunctionDeclaration(handleEvent) || !isFunctionDeclaration(empty)) return

                const addedToExisting = yield* Draft.functions.addParameter(project, handleEvent, {
                  name: "options",
                  type: "Options",
                })
                const addedToEmpty = yield* Draft.functions.addParameter(project, empty, {
                  name: "options",
                  type: "Options",
                })
                const typedEmpty = yield* Draft.functions.setReturnType(project, empty, "Result")
                const existingOutput = yield* applyFileEdits(source.text, addedToExisting.edits)
                const emptyOutput = yield* applyFileEdits(source.text, addedToEmpty.edits)
                const typedOutput = yield* applyFileEdits(source.text, typedEmpty.edits)

                expect(existingOutput).toContain(
                  "handleEvent<T extends (evt: Event) => void>(callback: T, options: Options)",
                )
                expect(emptyOutput).toContain(
                  "empty<T extends (evt: Event) => void>(options: Options)",
                )
                expect(typedOutput).toContain("empty<T extends (evt: Event) => void>(): Result")
                expect(emptyOutput).not.toContain("(evt: Event, options: Options)")
              }),
            )
          }),
        ),
      60_000,
    )

    effect(
      "inserts imports after shebangs, comments, and directives",
      () =>
        withFixture((root, app) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise(() =>
              Fs.writeFile(
                Path.join(root, "src/import-boundaries.ts"),
                [
                  "#!/usr/bin/env node",
                  "/** License header */",
                  '"use strict"',
                  '"use client"',
                  "",
                  "export const value = 1",
                  "",
                ].join("\n"),
              ),
            )
            const workspace = yield* Workspace
            yield* workspace.withSnapshot(
              {},
              Effect.gen(function* () {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)
                const source = yield* project.sourceFile("src/import-boundaries.ts")
                expect(source).toBeDefined()
                if (source === undefined) return
                const draft = yield* Draft.imports.addNamed(project, "src/import-boundaries.ts", {
                  module: "effect",
                  name: "Option",
                })
                const output = yield* applyFileEdits(source.text, draft.edits)
                expect(output.indexOf("#!/usr/bin/env node")).toBe(0)
                expect(output.indexOf('"use strict"')).toBeLessThan(
                  output.indexOf('import { Option } from "effect"'),
                )
                expect(output.indexOf('"use client"')).toBeLessThan(
                  output.indexOf('import { Option } from "effect"'),
                )
                expect(output.indexOf("License header")).toBeLessThan(
                  output.indexOf('import { Option } from "effect"'),
                )
              }),
            )
          }),
        ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 8. Automated Code Cleanup & Import Organizing
})
