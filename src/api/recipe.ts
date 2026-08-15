/**
 * Candidate public API — Transformation Recipes.
 *
 * A Recipe is a reusable program — authored by a human or an agent through
 * the same API — that queries a snapshot and returns a Draft. `Recipe.run`
 * is the engine: it opens the snapshot region, evaluates the body, records
 * the workspace inputs the plan depends on, attaches recipe identity and
 * policies, and finalizes the durable Transformation Plan. Recipes can never
 * forge snapshot evidence or return partial plans.
 */
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { textHash } from "../prototype/edits.ts"
import { NativeCompilerError } from "../prototype/native-compiler.ts"
import {
  finalizePlan,
  type Json,
  type PlanBuildError,
  type SourceFingerprint,
  type TransformationPlan,
} from "../prototype/plan.ts"
import { isWithinProject, projectRelativePath } from "../prototype/project-path.ts"
import type { Draft } from "./draft.ts"
import { Policy } from "./policy.ts"
import type { PlanPolicies } from "./plan.ts"
import {
  Workspace,
  WorkspaceSnapshot,
  type ProjectNotInSnapshot,
  type SnapshotExpired,
  type SnapshotTransition,
  type WorkspaceSnapshotService,
} from "./workspace.ts"

/**
 * Toolchain identity recorded in every plan. Candidate-pass constant:
 * production captures the real TypeScript/Effect/system versions at release
 * time; readers reject mismatched toolchains.
 */
export const TOOLCHAIN = {
  systemVersion: "0.0.0-teatime",
  typescriptVersion: "7.0.2",
  effectVersion: "4.0.0-rc.109",
} as const

/**
 * A reusable transformation. `run` is the recipe body: it evaluates inside a
 * Workspace Snapshot region and returns a Draft — nothing has been written,
 * finalized, or verified at that point.
 */
export interface Recipe<Input = undefined, E = never, R = never> {
  readonly name: string
  readonly version: string
  readonly implementationHash: string
  readonly policies: PlanPolicies
  readonly run: (input: Input) => Effect.Effect<Draft, E, R | WorkspaceSnapshot>
}

export interface RecipeDefinition<Input, E, R> {
  readonly version: string
  /**
   * Digest of the recipe implementation, supplied by the build/release
   * process. Defaults to a name@version digest suitable for development only.
   */
  readonly implementationHash?: string
  readonly policies?: ReadonlyArray<Policy>
  readonly run: (input: Input) => Effect.Effect<Draft, E, R | WorkspaceSnapshot>
}

const define = <Input = undefined, E = never, R = never>(
  name: string,
  definition: RecipeDefinition<Input, E, R>,
): Recipe<Input, E, R> =>
  Object.freeze({
    name,
    version: definition.version,
    implementationHash: definition.implementationHash ??
      createHash("sha256").update(`${name}@${definition.version}`).digest("hex"),
    policies: Policy.all(definition.policies ?? []),
    run: definition.run,
  })

const readText = (fileName: string): Effect.Effect<string, NativeCompilerError> =>
  Effect.tryPromise({
    try: () => Fs.readFile(fileName, "utf8"),
    catch: (cause) => new NativeCompilerError({ operation: "read workspace input", cause }),
  })

/**
 * Fingerprint every input the engine can observe for each configured
 * project: project-owned source files plus the configuration file. This is
 * the candidate-pass stand-in for the complete Snapshot Input Manifest.
 */
const fingerprintWorkspace = (
  workspaceRoot: string,
  snapshot: WorkspaceSnapshotService,
): Effect.Effect<
  ReadonlyArray<SourceFingerprint>,
  NativeCompilerError | ProjectNotInSnapshot | SnapshotExpired
> =>
  Effect.gen(function*() {
    const sources: Array<SourceFingerprint> = []
    for (const configured of snapshot.projects) {
      const project = yield* snapshot.project(configured)
      const owned = (yield* project.sourceFileNames()).filter((fileName) =>
        isWithinProject(project.root, fileName)
      )
      const files = [...new Set([...owned])].sort()
      const configFileName = Path.resolve(workspaceRoot, configured.config)
      for (const absolute of [configFileName, ...files]) {
        const content = yield* readText(absolute)
        sources.push({
          projectId: configured.id,
          fileName: projectRelativePath(project.root, absolute),
          hash: textHash(content),
        })
      }
    }
    return sources
  })

/**
 * Run a recipe end to planning: open a snapshot region, evaluate the body,
 * fingerprint the observed workspace, and finalize the durable plan.
 * No stage of `Recipe.run` writes project files.
 */
const run = <Input, E, R>(
  recipe: Recipe<Input, E, R>,
  input: Input,
  transition: SnapshotTransition = {},
): Effect.Effect<
  TransformationPlan,
  | E
  | PlanBuildError
  | NativeCompilerError
  | ProjectNotInSnapshot
  | SnapshotExpired,
  Workspace | Exclude<R, WorkspaceSnapshot>
> =>
  Effect.gen(function*() {
    const workspace = yield* Workspace
    return yield* workspace.withSnapshot(transition, Effect.gen(function*() {
      const snapshot = yield* WorkspaceSnapshot
      const draft = yield* recipe.run(input)
      return yield* finalizePlan({
        recipe: {
          name: recipe.name,
          version: recipe.version,
          implementationHash: recipe.implementationHash,
          options: (input ?? {}) as Json,
        },
        toolchain: TOOLCHAIN,
        projects: snapshot.projects.map((project) => ({
          id: project.id,
          configFileName: project.config,
        })),
        sources: yield* fingerprintWorkspace(workspace.root, snapshot),
        edits: draft.edits,
        evidence: draft.evidence,
        policies: recipe.policies,
        measurements: { matches: draft.matches },
      })
    }))
  })

export const Recipe = {
  define,
  run,
}
