import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import {
  calls,
  collect,
  referencesInProject,
  resolvesToSymbol,
  symbolAtPosition,
  whereBatched,
} from "./semantic-query.ts"
import { ConfiguredProject, layer, Workspace, WorkspaceSnapshot } from "./workspace-snapshot.ts"

const fixtureRoot = fileURLToPath(new URL("../../fixtures/query/", import.meta.url))
const configured = ConfiguredProject.make(Path.join(fixtureRoot, "tsconfig.json"))
const libraryFileName = Path.join(fixtureRoot, "src/library.ts")

const report = await Effect.runPromise(Workspace.use((workspace) => workspace.withSnapshot(
  {},
  Effect.gen(function*() {
    const snapshot = yield* WorkspaceSnapshot
    const project = yield* snapshot.project(configured)
    const target = yield* symbolAtPosition(project, libraryFileName, "export function ".length)
    if (target === undefined) return yield* Effect.die("Target symbol was not found")

    const selections = yield* calls(project).pipe(
      whereBatched(resolvesToSymbol(project, target)),
      collect,
    )
    const references = yield* referencesInProject(project, target)
    const resolvedReferences = yield* Effect.all(references.map((reference) => project.unsafeNative(() =>
      Effect.tryPromise({
        try: () => reference.resolve(),
        catch: (cause) => cause,
      }))))

    return {
      matchedCalls: selections.map((selection) => ({
        fileName: Path.relative(fixtureRoot, selection.fileName),
        text: selection.value.getText(),
        evidence: selection.evidence,
      })),
      references: references.map((reference, index) => ({
        canonicalFileName: String(reference.path),
        kind: reference.kind,
        index: reference.index,
        text: resolvedReferences[index]?.getText(),
      })),
    }
  }),
)).pipe(Effect.provide(layer(
  { projects: [configured] },
  { cwd: fixtureRoot },
))))

console.log(JSON.stringify(report, null, 2))
