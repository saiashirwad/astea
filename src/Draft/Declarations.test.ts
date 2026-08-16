import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as Application from "../Application/index.ts"
import * as Draft from "../Draft/index.ts"
import { applicationLayerNode } from "../Node/index.ts"
import * as Recipe from "../Recipe/index.ts"
import * as Verification from "../Verification/index.ts"
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import {
  isFunctionDeclaration,
  isInterfaceDeclaration,
} from "typescript/unstable/ast/is"
import { withFixture } from "../test/declarative-fixture.ts"

describe("declarative transformations API (@effect/vitest)", () => {
  describe("declaration combinators", () => {
    effect("modifies interfaces, classes, and function signatures with high-fidelity combinators", () =>
      withFixture((root, app) =>
        Effect.gen(function*() {
          const mainLayer = applicationLayerNode.pipe(
            Layer.provideMerge(Layer.succeed(Workspace, yield* Workspace)),
          )

          const declRecipe = Recipe.define("declaration-combinators-test", {
            version: "1.0.0",
            run: () =>
              Effect.gen(function*() {
                const snapshot = yield* WorkspaceSnapshot
                const project = yield* snapshot.project(app)

                // 1. Create a class file
                const classFileDraft = yield* Draft.files.create(
                  project,
                  "src/service.ts",
                  "export interface User { readonly id: string }\n\nexport class UserService {\n  public readonly endpoint: string = \"/api/users\";\n  public async getUser(id: string): Promise<User> {\n    return fetch(`${this.endpoint}/${id}`).then(r => r.json());\n  }\n}\n",
                )

                const lib = yield* project.sourceFile("src/library.ts")
                let libAccumulated = Draft.empty
                if (lib !== undefined) {
                  for (const statement of lib.statements) {
                    // Interface combinators
                    if (isInterfaceDeclaration(statement) && statement.name.text === "TargetInput") {
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
                      const d3 = yield* Draft.functions.setReturnType(project, statement, "number")
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
            Fs.readFile(Path.join(root, "src/library.ts"), "utf8")
          )
          expect(libContent).toContain("optionalFlag?: boolean;")
          expect(libContent).toContain("function other(value: number, tag?: string): number")

          const serviceContent = yield* Effect.tryPromise(() =>
            Fs.readFile(Path.join(root, "src/service.ts"), "utf8")
          )
          expect(serviceContent).toContain('public readonly endpoint: string = "/api/users";')
          expect(serviceContent).toContain("public async getUser(id: string): Promise<User>")
        })
      ),
      60_000,
    )
  })

  // ---------------------------------------------------------------------------
  // 8. Automated Code Cleanup & Import Organizing
})
