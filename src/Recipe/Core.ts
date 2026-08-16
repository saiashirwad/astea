/**
 * Recipe domain — transformation orchestration.
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
import { SYSTEM_VERSION } from "../generated/version.ts"
import { EditConflict, InvalidEdit, applyFileEdits, textHash, type TextEdit } from "../Edit/index.ts"
import { NativeCompilerError } from "../Compiler/Service.ts"
import {
  finalizePlan,
  type Json,
  type PlanBuildError,
  type PlannedFileOperation,
  type SourceFingerprint,
  type TransformationPlan,
} from "../Plan/index.ts"
import { isWithinProject, projectRelativePath } from "../Workspace/ProjectPath.ts"
import * as Draft from "../Draft/index.ts"
import type { Draft as DraftModel } from "../Draft/index.ts"
import type { Policy as PolicyModel, VerificationRule } from "../Policy/index.ts"
import * as Policy from "../Policy/index.ts"
import type { PlanPolicies } from "../Plan/index.ts"
import { run as runOverlay } from "../Overlay/index.ts"
import {
  Workspace,
  WorkspaceSnapshot,
  type ProjectNotInSnapshot,
  type ProjectSnapshotError,
  type SnapshotExpired,
  type SnapshotTransition,
  type WorkspaceSnapshotService,
  FileNotFound,
} from "../Workspace/index.ts"

/**
 * Toolchain identity recorded in every plan. Candidate-pass constant:
 * production captures the real TypeScript/Effect/system versions at release
 * time; readers reject mismatched toolchains.
 */
export const TOOLCHAIN = {
  systemVersion: SYSTEM_VERSION,
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
  readonly schema?: Schema.Schema<Input> | undefined
  readonly run: (input: Input) => Effect.Effect<DraftModel, E, R | WorkspaceSnapshot | Workspace>
}

export interface RecipeDefinition<Input, E, R> {
  readonly version: string
  readonly schema?: Schema.Schema<Input>
  /**
   * Digest of the recipe implementation, supplied by the build/release
   * process. Defaults to a name@version digest suitable for development only.
   */
  readonly implementationHash?: string
  readonly policies?: ReadonlyArray<PolicyModel>
  readonly run: (input: Input) => Effect.Effect<DraftModel, E, R | WorkspaceSnapshot | Workspace>
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
  readonly schema?: Schema.Schema<Input> | undefined
  /**
   * Digest of the recipe implementation, supplied by the build/release
   * process. Defaults to a name@version digest suitable for development only.
   */
  readonly implementationHash?: string
  readonly policies?: ReadonlyArray<PolicyModel>
  readonly scan: (input: Input) => Effect.Effect<Acc, E1, R1 | WorkspaceSnapshot | Workspace>
  readonly run: (accumulator: Acc, input: Input) => Effect.Effect<DraftModel, E2, R2 | WorkspaceSnapshot | Workspace>
}

/**
 * Construct a recipe from an already compiled policy set.
 *
 * `define` accepts author-facing policies and compiles them.  Combinators,
 * however, receive the compiled durable policy and the non-serializable
 * runtime rules from their children.  Keeping this constructor separate from
 * `define` prevents a combinator from accidentally treating a PlanPolicies
 * value as an authoring Policy (and, in particular, dropping its rules).
 */
const fromCompiled = <Input, E, R>(
  name: string,
  version: string,
  compiled: { readonly policy: PlanPolicies; readonly rules: ReadonlyArray<VerificationRule> },
  run: Recipe<Input, E, R>["run"],
  options: {
    readonly schema?: Schema.Schema<Input> | undefined
    readonly implementationHash?: string | undefined
  } = {},
): Recipe<Input, E, R> => Object.freeze({
  name,
  version,
  schema: options.schema,
  implementationHash: options.implementationHash ??
    createHash("sha256").update(`${name}@${version}`).digest("hex"),
  policies: compiled.policy,
  rules: compiled.rules,
  run,
})

const composedSchema = <Input>(recipes: ReadonlyArray<Recipe<Input, any, any>>): Schema.Schema<Input> | undefined => {
  const schemas = recipes.flatMap((recipe) => recipe.schema === undefined ? [] : [recipe.schema])
  const schema = schemas[0]
  // Schema-less children accept the validated input of a schema-bearing
  // sibling. Distinct schemas would make the durable encoding ambiguous, so
  // fail at composition time instead of silently bypassing validation.
  if (schema !== undefined && !schemas.every((candidate) => candidate === schema)) {
    throw new TypeError("Composed recipes must use the same input schema")
  }
  return schema
}

const composedIdentity = (
  name: string,
  version: string,
  recipes: ReadonlyArray<Recipe<any, any, any>>,
): string => createHash("sha256")
  .update(`${name}@${version}:${recipes.map((recipe) => recipe.implementationHash).join(",")}`)
  .digest("hex")

const compileChildren = (recipes: ReadonlyArray<Recipe<any, any, any>>) => ({
  // Durable fields are merged independently from runtime rules.  Compiled
  // policies contain system defaults, so feeding them back through
  // `Policy.all` would let a child with no match bound erase another child's
  // bound.  Merge each optional dimension by its meaningful values instead.
  policy: (() => {
    const matchCount: { min?: number; max?: number } = {}
    let maxAffectedFiles: number | undefined
    let diagnostics: PlanPolicies["diagnostics"] = "no-new-errors"
    let idempotence: PlanPolicies["idempotence"] = "not-promised"
    for (const recipe of recipes) {
      const policy = recipe.policies
      if (policy.matchCount.min !== undefined) matchCount.min = policy.matchCount.min
      if (policy.matchCount.max !== undefined) matchCount.max = policy.matchCount.max
      if (policy.maxAffectedFiles !== undefined) maxAffectedFiles = policy.maxAffectedFiles
      if (policy.diagnostics === "exact-delta") diagnostics = "exact-delta"
      if (policy.idempotence === "required") idempotence = "required"
    }
    return maxAffectedFiles === undefined
      ? { matchCount, diagnostics, idempotence }
      : { matchCount, maxAffectedFiles, diagnostics, idempotence }
  })(),
  rules: recipes.flatMap((recipe) => recipe.rules),
})

export const define = <Input = undefined, E = never, R = never>(
  name: string,
  definition: RecipeDefinition<Input, E, R>,
): Recipe<Input, E, R> => {
  const compiled = Policy.all(definition.policies ?? [])
  return fromCompiled(name, definition.version, compiled, definition.run, {
    schema: definition.schema,
    implementationHash: definition.implementationHash,
  })
}

/**
 * Define a two-phase scanning transformation recipe with a global accumulator.
 * Phase 1 (`scan`) analyzes the workspace snapshot to build a global cross-file model/accumulator.
 * Phase 2 (`run`) receives the accumulator to execute transformations across files.
 */
export const scanning = <Acc, Input = undefined, E1 = never, R1 = never, E2 = never, R2 = never>(
  name: string,
  definition: ScanningRecipeDefinition<Acc, Input, E1, R1, E2, R2>,
): ScanningRecipe<Acc, Input, E1 | E2, R1 | R2> => {
  const scan = definition.scan
  const runWithAcc = definition.run
  const compiled = Policy.all(definition.policies ?? [])
  const recipe = fromCompiled(name, definition.version, compiled, (input: Input) =>
    Effect.gen(function*() {
      const acc = yield* scan(input)
      return yield* runWithAcc(acc, input)
    }), {
    schema: definition.schema,
    implementationHash: definition.implementationHash,
  })
  return Object.freeze({ ...recipe, scan })
}


const composeDrafts = (
  snapshot: WorkspaceSnapshotService,
  accumulated: DraftModel,
  next: DraftModel,
): Effect.Effect<DraftModel, ProjectSnapshotError | ProjectNotInSnapshot | FileNotFound | InvalidEdit | EditConflict> =>
  Effect.gen(function*() {
    const accumulatedChanged = accumulated.edits.length > 0 || (accumulated.fileOperations?.length ?? 0) > 0
    const nextChanged = next.edits.length > 0 || (next.fileOperations?.length ?? 0) > 0
    if (!accumulatedChanged) return next
    if (!nextChanged) return accumulated

    const accumulatedByFile = Map.groupBy(accumulated.edits, (e) => `${e.projectId}\0${e.fileName}`)
    const nextByFile = Map.groupBy(next.edits, (e) => `${e.projectId}\0${e.fileName}`)

    const allKeys = new Set([...accumulatedByFile.keys(), ...nextByFile.keys()])
    const combinedEdits: Array<TextEdit> = []

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

    const fileOperations = [
        ...(accumulated.fileOperations ?? []),
        ...(next.fileOperations ?? []),
      ]
    const consumed = new Set<string>()
    const normalizedOperations: Array<PlannedFileOperation> = []
    for (const operation of fileOperations) {
      const sourceKey = `${operation.projectId}\0${operation.path}`
      const targetKey = operation.kind === "move"
        ? `${operation.projectId}\0${operation.toPath}`
        : undefined
      const operationEditKey = operation.kind === "move" ? targetKey : sourceKey
      const operationEdits = operationEditKey === undefined
        ? undefined
        : combinedEdits.filter((edit) => `${edit.projectId}\0${edit.fileName}` === operationEditKey)
      let normalized = operation
      if (operationEdits !== undefined && operationEdits.length > 0) {
        consumed.add(operationEditKey!)
        if (operation.kind === "create" || operation.kind === "move") {
          const content = yield* applyFileEdits(operation.content ?? "", operationEdits)
          normalized = { ...operation, content }
        }
      }

      if (operation.kind === "delete" || operation.kind === "move") {
        const producerIndex = normalizedOperations.findIndex((candidate) =>
          candidate.projectId === operation.projectId &&
          ((candidate.kind === "create" && candidate.path === operation.path) ||
            (candidate.kind === "move" && candidate.toPath === operation.path))
        )
        const producer = normalizedOperations[producerIndex]
        if (producer !== undefined && (producer.kind === "create" || producer.kind === "move")) {
          const evidenceIds = [...new Set([
            ...(producer.evidenceIds ?? []),
            ...(operation.evidenceIds ?? []),
          ])]
          consumed.add(sourceKey)
          if (operation.kind === "delete") {
            normalizedOperations.splice(producerIndex, 1)
          } else if (producer.kind === "create") {
            normalizedOperations[producerIndex] = {
              kind: "create",
              projectId: producer.projectId,
              path: operation.toPath,
              content: normalized.kind === "move" && normalized.content !== undefined
                ? normalized.content
                : producer.content,
              evidenceIds,
            }
          } else {
            normalizedOperations[producerIndex] = {
              kind: "move",
              projectId: producer.projectId,
              path: producer.path,
              toPath: operation.toPath,
              initialHash: producer.initialHash,
              content: normalized.kind === "move" && normalized.content !== undefined
                ? normalized.content
                : producer.content,
              evidenceIds,
            }
          }
          if (operation.kind === "move") consumed.add(targetKey!)
          continue
        }
      }

      if (operation.kind === "delete" || operation.kind === "move") {
        const configured = snapshot.projects.find((project) => project.id === operation.projectId)
        if (configured !== undefined) {
          const project = yield* snapshot.project(configured)
          const original = yield* project.sourceText(operation.path)
          normalized = operation.kind === "delete"
            ? { ...operation, initialHash: textHash(original) }
            : {
              ...operation,
              ...(normalized.kind === "move" && normalized.content !== undefined
                ? { content: normalized.content }
                : {}),
              initialHash: textHash(original),
            }
        }
      }
      // Edits to a deleted/moved source cannot survive the operation.  A move
      // carries its source content in the operation itself, so source edits
      // are likewise already represented by the operation's content.
      if (operation.kind === "delete" || operation.kind === "move") consumed.add(sourceKey)
      normalizedOperations.push(normalized)
    }

    return {
      edits: combinedEdits.filter((edit) => !consumed.has(`${edit.projectId}\0${edit.fileName}`)),
      fileOperations: normalizedOperations,
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
  const compiled = compileChildren(recipes)

  return fromCompiled(name, version, compiled, (input: Input) =>
      Effect.gen(function*() {
        const snapshot = yield* WorkspaceSnapshot
        let accumulatedDraft = Draft.empty
        for (const recipe of recipes) {
          if (accumulatedDraft.edits.length > 0 || (accumulatedDraft.fileOperations?.length ?? 0) > 0) {
            const nextDraft = yield* runOverlay(accumulatedDraft, recipe.run(input))
            accumulatedDraft = yield* composeDrafts(snapshot, accumulatedDraft, nextDraft)
          } else {
            const nextDraft = yield* recipe.run(input)
            accumulatedDraft = Draft.concat(accumulatedDraft, nextDraft)
          }
        }
        return accumulatedDraft
      }), {
    schema: composedSchema(recipes),
    implementationHash: composedIdentity(name, version, recipes),
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
  const compiled = compileChildren(recipes)

  return fromCompiled(name, version, compiled, (input: Input) =>
      Effect.forEach(recipes, (r) => r.run(input), { concurrency: "unbounded" }).pipe(
        Effect.map((drafts) => Draft.concat(...drafts)),
      ), {
    schema: composedSchema(recipes),
    implementationHash: composedIdentity(name, version, recipes),
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
  const children = [ifTrue, ifFalse]
  const compiled = compileChildren(children)

  return fromCompiled(name, version, compiled, (input: Input) =>
      Effect.gen(function*() {
        const snapshot = yield* WorkspaceSnapshot
        const result = predicate(snapshot)
        const cond = Effect.isEffect(result) ? yield* result : result
        return cond ? yield* ifTrue.run(input) : yield* ifFalse.run(input)
      }), {
    schema: composedSchema(children),
    implementationHash: composedIdentity(name, version, children),
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
    fromCompiled(`${recipe.name}:noop`, recipe.version, {
      policy: Policy.all([]).policy,
      rules: [],
    }, () => Effect.succeed(Draft.empty), {
      // The no-op branch still carries the same input schema so `when` can
      // validate its input exactly as the wrapped recipe does.
      schema: recipe.schema,
      implementationHash: createHash("sha256")
        .update(`${recipe.implementationHash}:noop`)
        .digest("hex"),
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
export const run = <Input, E, R>(
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
    let encodedOptions: Json = (input === undefined ? null : input) as Json
    if (recipe.schema !== undefined) {
      const schema = recipe.schema
      // SAFETY: recipe schemas are pure and fail only with SchemaError.
      const decode = Schema.decodeUnknownEffect(schema) as (value: Input) => Effect.Effect<Input, Schema.SchemaError, never>
      const decoded = yield* decode(input).pipe(
        Effect.mapError((cause) => new RecipeInputError({ recipe: recipe.name, cause })),
      )
      validatedInput = decoded
      const encode = Schema.encodeUnknownEffect(schema) as (
        value: Input,
      ) => Effect.Effect<unknown, Schema.SchemaError, never>
      const encoded = yield* encode(decoded).pipe(
        Effect.mapError((cause) => new RecipeInputError({ recipe: recipe.name, cause })),
      )
      // Schema encodings are the durable input representation.  The schema
      // boundary guarantees the result is JSON-compatible for recipe options.
      encodedOptions = encoded as Json
    }

    const workspace = yield* Workspace
    return yield* workspace.withSnapshot(transition, Effect.gen(function*() {
      const snapshot = yield* WorkspaceSnapshot
      const draft = yield* recipe.run(validatedInput)
      const sources = yield* fingerprintWorkspace(workspace.root, snapshot)
      const declaredEvidence = new Set(draft.evidence.map((item) => item.id))
      const referencedEvidence = new Set([
        ...draft.edits.flatMap((edit) => edit.evidenceIds),
        ...(draft.fileOperations ?? []).flatMap((operation) => operation.evidenceIds ?? []),
      ])
      const evidence = [
        ...draft.evidence,
        ...[...referencedEvidence]
          .filter((id) => !declaredEvidence.has(id))
          .map((id) => ({ id, kind: "draft-operation", facts: {} })),
      ]

      const planInput = {
        recipe: {
          name: recipe.name,
          version: recipe.version,
          implementationHash: recipe.implementationHash,
          // SAFETY: validated options represent JSON payload
          options: encodedOptions,
        },
        toolchain: TOOLCHAIN,
        projects: snapshot.projects.map((configured) => ({
          id: configured.id,
          configFileName: configured.config,
        })),
        sources,
        edits: draft.edits,
        evidence,
        policies: recipe.policies,
        measurements: { matches: draft.matches },
      }
      const finalizedInput = draft.fileOperations !== undefined
        ? { ...planInput, fileOperations: draft.fileOperations }
        : planInput

      return yield* finalizePlan(finalizedInput)
    }))
  })
