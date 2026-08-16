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
import { Data, Effect, Schema } from "effect"
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
import { Draft } from "./draft.ts"
import { type CustomPolicyRule, Policy } from "./policy.ts"
import type { PlanPolicies } from "./plan.ts"
import {
  overlay,
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

export class RecipeInputError extends Data.TaggedError("RecipeInputError")<{
  readonly recipe: string
  readonly cause: unknown
}> {}

/**
 * A reusable transformation. `run` is the recipe body: it evaluates inside a
 * Workspace Snapshot region and returns a Draft — nothing has been written,
 * finalized, or verified at that point.
 */
export interface Recipe<Input = undefined, E = never, R = never> {
  readonly name: string
  readonly version: string
  readonly implementationHash: string
  readonly policies: PlanPolicies & { readonly rules?: ReadonlyArray<CustomPolicyRule> }
  readonly schema?: Schema.Schema<Input>
  readonly run: (input: Input) => Effect.Effect<Draft, E, R | WorkspaceSnapshot | Workspace>
}

export interface RecipeDefinition<Input, E, R> {
  readonly version: string
  readonly schema?: Schema.Schema<Input>
  /**
   * Digest of the recipe implementation, supplied by the build/release
   * process. Defaults to a name@version digest suitable for development only.
   */
  readonly implementationHash?: string
  readonly policies?: ReadonlyArray<Policy>
  readonly run: (input: Input) => Effect.Effect<Draft, E, R | WorkspaceSnapshot | Workspace>
}

const define = <Input = undefined, E = never, R = never>(
  name: string,
  definition: RecipeDefinition<Input, E, R>,
): Recipe<Input, E, R> =>
  Object.freeze({
    name,
    version: definition.version,
    schema: definition.schema,
    implementationHash: definition.implementationHash ??
      createHash("sha256").update(`${name}@${definition.version}`).digest("hex"),
    policies: Policy.all(definition.policies ?? []),
    run: definition.run,
  })

/** Sequentially compose recipes, projecting intermediate states via in-memory snapshot overlays. */
export const pipe = <Input = undefined, E = never, R = never>(
  ...recipes: ReadonlyArray<Recipe<Input, any, any>>
): Recipe<Input, E, R> => {
  const name = recipes.map((r) => r.name).join(" >> ")
  const version = recipes.map((r) => r.version).join("+")
  const policies = Policy.all(recipes.flatMap((r) => [r.policies]))

  return define(name, {
    version,
    policies: [policies],
    run: (input: Input) =>
      Effect.gen(function*() {
        let accumulatedDraft = Draft.empty
        for (const recipe of recipes) {
          if (accumulatedDraft.edits.length > 0) {
            const nextDraft = yield* overlay(accumulatedDraft, recipe.run(input))
            accumulatedDraft = Draft.concat(accumulatedDraft, nextDraft)
          } else {
            const nextDraft = yield* recipe.run(input)
            accumulatedDraft = Draft.concat(accumulatedDraft, nextDraft)
          }
        }
        return accumulatedDraft
      }),
  })
}

/** Concurrently run recipes over the current snapshot and merge their drafts. */
export const all = <Input = undefined, E = never, R = never>(
  recipes: ReadonlyArray<Recipe<Input, any, any>>,
): Recipe<Input, E, R> => {
  const name = `all(${recipes.map((r) => r.name).join(", ")})`
  const version = recipes.map((r) => r.version).join("+")
  const policies = Policy.all(recipes.flatMap((r) => [r.policies]))

  return define(name, {
    version,
    policies: [policies],
    run: (input: Input) =>
      Effect.forEach(recipes, (r) => r.run(input), { concurrency: "unbounded" }).pipe(
        Effect.map((drafts) => Draft.concat(...drafts)),
      ),
  })
}

/** Conditionally execute one of two recipes based on a snapshot predicate. */
export const branch = <Input = undefined, E1 = never, R1 = never, E2 = never, R2 = never>(
  predicate: (snapshot: WorkspaceSnapshotService) => Effect.Effect<boolean, any, any> | boolean,
  ifTrue: Recipe<Input, E1, R1>,
  ifFalse: Recipe<Input, E2, R2>,
): Recipe<Input, E1 | E2, R1 | R2> => {
  const name = `branch(${ifTrue.name}, ${ifFalse.name})`
  const version = `${ifTrue.version}|${ifFalse.version}`

  return define(name, {
    version,
    run: (input: Input) =>
      Effect.gen(function*() {
        const snapshot = yield* WorkspaceSnapshot
        const result = predicate(snapshot)
        const cond = typeof result === "boolean" ? result : yield* result
        return cond ? yield* ifTrue.run(input) : yield* ifFalse.run(input)
      }),
  })
}

/** Conditionally execute a recipe if a snapshot predicate holds. */
export const when = <Input = undefined, E = never, R = never>(
  predicate: (snapshot: WorkspaceSnapshotService) => Effect.Effect<boolean, any, any> | boolean,
  recipe: Recipe<Input, E, R>,
): Recipe<Input, E, R> =>
  branch(
    predicate,
    recipe,
    define(`${recipe.name}:noop`, {
      version: recipe.version,
      run: () => Effect.succeed(Draft.empty),
    }),
  )

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
      const files = [...new Set(owned)].sort()
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
  | RecipeInputError
  | PlanBuildError
  | NativeCompilerError
  | ProjectNotInSnapshot
  | SnapshotExpired,
  Workspace | Exclude<R, WorkspaceSnapshot>
> =>
  Effect.gen(function*() {
    let validatedInput = input
    if (recipe.schema !== undefined) {
      // SAFETY: schema decodeUnknownEffect validates untrusted input into type Input
      const decoder = Schema.decodeUnknownEffect(recipe.schema) as (u: unknown) => Effect.Effect<Input, unknown>
      const decoded: Input = yield* decoder(input).pipe(
        Effect.mapError((cause) => new RecipeInputError({ recipe: recipe.name, cause })),
      )
      validatedInput = decoded
    }

    const workspace = yield* Workspace
    return yield* workspace.withSnapshot(transition, Effect.gen(function*() {
      const snapshot = yield* WorkspaceSnapshot
      const draft = yield* recipe.run(validatedInput)
      const sources = yield* fingerprintWorkspace(workspace.root, snapshot)

      const planInput = {
        recipe: {
          name: recipe.name,
          version: recipe.version,
          implementationHash: recipe.implementationHash,
          // SAFETY: validated options represent JSON payload
          options: (validatedInput === undefined ? null : validatedInput) as Json,
        },
        toolchain: TOOLCHAIN,
        projects: snapshot.projects.map((configured) => ({
          id: configured.id,
          configFileName: configured.config,
        })),
        sources,
        edits: draft.edits,
        evidence: draft.evidence,
        policies: recipe.policies,
        measurements: { matches: draft.matches },
      }
      const finalizedInput = draft.fileOperations !== undefined
        ? { ...planInput, fileOperations: draft.fileOperations }
        : planInput

      return yield* finalizePlan(finalizedInput)
    }))
  })

export const Recipe = {
  define,
  pipe,
  all,
  branch,
  when,
  run,
}
