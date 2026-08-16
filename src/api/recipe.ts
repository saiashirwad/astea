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
import { path as Path, nodeFsPromises as Fs } from "../platform/node.ts"
import { createHash } from "node:crypto"
import { Data, Effect, Schema } from "effect"
import { EditConflict, InvalidEdit, applyFileEdits, textHash } from "../Edit/index.ts"
import { NativeCompilerError } from "../internal/native-compiler.ts"
import {
  finalizePlan,
  type Json,
  type PlanBuildError,
  type PlannedTextEdit,
  type SourceFingerprint,
  type TransformationPlan,
} from "../internal/plan.ts"
import { isWithinProject, projectRelativePath } from "../internal/project-path.ts"
import { Draft } from "./draft.ts"
import { type VerificationRule, Policy } from "./policy.ts"
import type { PlanPolicies } from "./plan.ts"
import {
  overlay,
  Workspace,
  WorkspaceSnapshot,
  type ProjectNotInSnapshot,
  type ProjectSnapshotError,
  type SnapshotExpired,
  type SnapshotTransition,
  type WorkspaceSnapshotService,
  FileNotFound,
} from "./workspace.ts"

/**
 * Toolchain identity recorded in every plan. Candidate-pass constant:
 * production captures the real TypeScript/Effect/system versions at release
 * time; readers reject mismatched toolchains.
 */
export const TOOLCHAIN = {
  systemVersion: "0.0.0-safemods",
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
  readonly policies: PlanPolicies
  readonly rules: ReadonlyArray<VerificationRule>
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

/**
 * A two-phase scanning transformation recipe.
 * Phase 1 (`scan`) performs a read-only analysis over the workspace to build an accumulator.
 * Phase 2 (`run`) uses the accumulator to generate transformation drafts.
 */
export interface ScanningRecipe<Acc, Input = undefined, E = never, R = never> extends Recipe<Input, E, R> {
  readonly scan: (input: Input) => Effect.Effect<Acc, E, R | WorkspaceSnapshot | Workspace>
}

export interface ScanningRecipeDefinition<Acc, Input = undefined, E1 = never, R1 = never, E2 = never, R2 = never> {
  readonly version: string
  readonly schema?: Schema.Schema<Input>
  /**
   * Digest of the recipe implementation, supplied by the build/release
   * process. Defaults to a name@version digest suitable for development only.
   */
  readonly implementationHash?: string
  readonly policies?: ReadonlyArray<Policy>
  readonly scan: (input: Input) => Effect.Effect<Acc, E1, R1 | WorkspaceSnapshot | Workspace>
  readonly run: (accumulator: Acc, input: Input) => Effect.Effect<Draft, E2, R2 | WorkspaceSnapshot | Workspace>
}

const define = <Input = undefined, E = never, R = never>(
  name: string,
  definition: RecipeDefinition<Input, E, R>,
): Recipe<Input, E, R> => {
  const compiled = Policy.all(definition.policies ?? [])
  return Object.freeze({
    name,
    version: definition.version,
    schema: definition.schema,
    implementationHash: definition.implementationHash ??
      createHash("sha256").update(`${name}@${definition.version}`).digest("hex"),
    policies: compiled.policy,
    rules: compiled.rules,
    run: definition.run,
  })
}

/**
 * Define a two-phase scanning transformation recipe with a global accumulator.
 * Phase 1 (`scan`) analyzes the workspace snapshot to build a global cross-file model/accumulator.
 * Phase 2 (`run`) receives the accumulator to execute transformations across files.
 */
const scanning = <Acc, Input = undefined, E1 = never, R1 = never, E2 = never, R2 = never>(
  name: string,
  definition: ScanningRecipeDefinition<Acc, Input, E1, R1, E2, R2>,
): ScanningRecipe<Acc, Input, E1 | E2, R1 | R2> => {
  const scan = definition.scan
  const runWithAcc = definition.run
  const compiled = Policy.all(definition.policies ?? [])
  return Object.freeze({
    name,
    version: definition.version,
    schema: definition.schema,
    implementationHash: definition.implementationHash ??
      createHash("sha256").update(`${name}@${definition.version}`).digest("hex"),
    policies: compiled.policy,
    rules: compiled.rules,
    scan,
    run: (input: Input) =>
      Effect.gen(function*() {
        const acc = yield* scan(input)
        return yield* runWithAcc(acc, input)
      }),
  })
}


const composeDrafts = (
  snapshot: WorkspaceSnapshotService,
  accumulated: Draft,
  next: Draft,
): Effect.Effect<Draft, ProjectSnapshotError | ProjectNotInSnapshot | FileNotFound | InvalidEdit | EditConflict> =>
  Effect.gen(function*() {
    if (accumulated.edits.length === 0) return next
    if (next.edits.length === 0) return accumulated

    const accumulatedByFile = Map.groupBy(accumulated.edits, (e) => `${e.projectId}\0${e.fileName}`)
    const nextByFile = Map.groupBy(next.edits, (e) => `${e.projectId}\0${e.fileName}`)

    const allKeys = new Set([...accumulatedByFile.keys(), ...nextByFile.keys()])
    const combinedEdits: Array<PlannedTextEdit> = []

    for (const key of allKeys) {
      const accEdits = accumulatedByFile.get(key)
      const nxtEdits = nextByFile.get(key)

      if (accEdits && !nxtEdits) {
        combinedEdits.push(...accEdits)
      } else if (!accEdits && nxtEdits) {
        combinedEdits.push(...nxtEdits)
      } else if (accEdits && nxtEdits) {
        // SAFETY: File keys in edit maps are composed by construction as `${projectId}\0${fileName}`.
        const [projectId, fileName] = key.split("\0") as [string, string]
        const projectDef = snapshot.projects.find((p) => p.id === projectId)
        if (!projectDef) continue
        const project = yield* snapshot.project(projectDef)
        const t0 = yield* project.sourceText(fileName)

        const t1 = yield* applyFileEdits(t0, accEdits)

        const t2 = yield* applyFileEdits(t1, nxtEdits)

        if (t0 === t2) {
          continue
        }

        let start = 0
        while (start < t0.length && start < t2.length && t0[start] === t2[start]) {
          start++
        }

        let end0 = t0.length
        let end2 = t2.length
        while (end0 > start && end2 > start && t0[end0 - 1] === t2[end2 - 1]) {
          end0--
          end2--
        }

        const newText = t2.slice(start, end2)
        const evidenceIds = [...new Set([...accEdits.flatMap((e) => e.evidenceIds), ...nxtEdits.flatMap((e) => e.evidenceIds)])]

        combinedEdits.push({
          projectId,
          fileName,
          start,
          end: end0,
          expectedTextHash: textHash(t0.slice(start, end0)),
          newText,
          evidenceIds,
        })
      }
    }

    return {
      edits: combinedEdits,
      fileOperations: [
        ...(accumulated.fileOperations ?? []),
        ...(next.fileOperations ?? []),
      ],
      evidence: [...accumulated.evidence, ...next.evidence],
      matches: accumulated.matches + next.matches,
    }
  })

/** Sequentially compose recipes, projecting intermediate states via in-memory snapshot overlays. */
export function pipe<Input, E1, R1, E2, R2>(
  r1: Recipe<Input, E1, R1>,
  r2: Recipe<Input, E2, R2>,
): Recipe<Input, E1 | E2 | EditConflict | InvalidEdit | FileNotFound | NativeCompilerError | ProjectNotInSnapshot | SnapshotExpired, R1 | R2>
export function pipe<Input, E1, R1, E2, R2, E3, R3>(
  r1: Recipe<Input, E1, R1>,
  r2: Recipe<Input, E2, R2>,
  r3: Recipe<Input, E3, R3>,
): Recipe<Input, E1 | E2 | E3 | EditConflict | InvalidEdit | FileNotFound | NativeCompilerError | ProjectNotInSnapshot | SnapshotExpired, R1 | R2 | R3>
export function pipe<Input, E1, R1, E2, R2, E3, R3, E4, R4>(
  r1: Recipe<Input, E1, R1>,
  r2: Recipe<Input, E2, R2>,
  r3: Recipe<Input, E3, R3>,
  r4: Recipe<Input, E4, R4>,
): Recipe<Input, E1 | E2 | E3 | E4 | EditConflict | InvalidEdit | FileNotFound | NativeCompilerError | ProjectNotInSnapshot | SnapshotExpired, R1 | R2 | R3 | R4>
export function pipe<Input, E, R>(
  ...recipes: ReadonlyArray<Recipe<Input, E, R>>
): Recipe<Input, E | EditConflict | InvalidEdit | FileNotFound | NativeCompilerError | ProjectNotInSnapshot | SnapshotExpired, R> {
  const name = recipes.map((r) => r.name).join(" >> ")
  const version = recipes.map((r) => r.version).join("+")
  const policies = Policy.all(recipes.flatMap((r) => [r.policies]))

  return define(name, {
    version,
    policies: [policies],
    run: (input: Input) =>
      Effect.gen(function*() {
        const snapshot = yield* WorkspaceSnapshot
        let accumulatedDraft = Draft.empty
        for (const recipe of recipes) {
          if (accumulatedDraft.edits.length > 0) {
            const nextDraft = yield* overlay(accumulatedDraft, recipe.run(input))
            accumulatedDraft = yield* composeDrafts(snapshot, accumulatedDraft, nextDraft)
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
export function all<Input, E1, R1, E2, R2>(
  recipes: readonly [Recipe<Input, E1, R1>, Recipe<Input, E2, R2>],
): Recipe<Input, E1 | E2 | EditConflict | InvalidEdit | FileNotFound | NativeCompilerError | ProjectNotInSnapshot | SnapshotExpired, R1 | R2>
export function all<Input, E1, R1, E2, R2, E3, R3>(
  recipes: readonly [Recipe<Input, E1, R1>, Recipe<Input, E2, R2>, Recipe<Input, E3, R3>],
): Recipe<Input, E1 | E2 | E3 | EditConflict | InvalidEdit | FileNotFound | NativeCompilerError | ProjectNotInSnapshot | SnapshotExpired, R1 | R2 | R3>
export function all<Input, E, R>(
  recipes: ReadonlyArray<Recipe<Input, E, R>>,
): Recipe<Input, E | EditConflict | InvalidEdit | FileNotFound | NativeCompilerError | ProjectNotInSnapshot | SnapshotExpired, R> {
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

export type SnapshotPredicate = (
  snapshot: WorkspaceSnapshotService,
) => boolean | Effect.Effect<boolean>

/** Conditionally execute one of two recipes based on a snapshot predicate. */
export const branch = <Input = undefined, E1 = never, R1 = never, E2 = never, R2 = never>(
  predicate: SnapshotPredicate,
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
        const cond = Effect.isEffect(result) ? yield* result : result
        return cond ? yield* ifTrue.run(input) : yield* ifFalse.run(input)
      }),
  })
}

/** Conditionally execute a recipe if a snapshot predicate holds. */
export const when = <Input = undefined, E = never, R = never>(
  predicate: SnapshotPredicate,
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
      const owned = (yield* project.sourceFileNames).filter((fileName) =>
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
      // SAFETY: recipe schemas are pure and fail only with SchemaError.
      const decode = Schema.decodeUnknownEffect(recipe.schema) as (value: Input) => Effect.Effect<Input, Schema.SchemaError, never>
      const decoded = yield* decode(input).pipe(
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
  scanning,
  pipe,
  all,
  branch,
  when,
  run,
}
