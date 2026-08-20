import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { describe, effect, expect } from "@effect/vitest"
import { Effect } from "effect"
import * as Draft from "../Draft/index.ts"
import { applyFileEdits } from "../Edit/index.ts"
import { Workspace, WorkspaceSnapshot } from "../Workspace/index.ts"
import { withFixture } from "../test/declarative-fixture.ts"

describe("Draft.imports API (@effect/vitest)", () => {
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
