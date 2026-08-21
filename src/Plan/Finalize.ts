/** Normalize Plan input and assign its content-addressed identifiers. */
import { Effect } from "effect"
import { compareEdits, editsConflict } from "../Edit/index.ts"
import { asJson, canonicalJson, digest, withoutPlanId } from "./Canonical.ts"
import { PlanBuildError, type PlanInput, type TransformationPlan } from "./TransformationPlan.ts"
import { compareSourceFingerprints, normalizedPath, validateInput } from "./Validate.ts"

export const finalizePlan = (input: PlanInput): Effect.Effect<TransformationPlan, PlanBuildError> =>
  Effect.gen(function* () {
    yield* validateInput(input)
    const projects = [...input.projects]
      .map((project) => ({
        ...project,
        configFileName: normalizedPath(project.configFileName)!,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
    const sources = [...input.sources]
      .map((source) => ({
        ...source,
        fileName: normalizedPath(source.fileName)!,
      }))
      .sort(compareSourceFingerprints)
    const edits = [...input.edits]
      .map((edit) => ({
        ...edit,
        fileName: normalizedPath(edit.fileName)!,
        evidenceIds: [...edit.evidenceIds].sort(),
      }))
      .sort(compareEdits)
    const evidence = [...input.evidence].sort((left, right) => left.id.localeCompare(right.id))

    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index]!
      const previous = edits[index - 1]
      if (previous !== undefined && editsConflict(previous, edit)) {
        return yield* new PlanBuildError({ reason: "edit-conflict", detail: edit.fileName })
      }
    }

    const fileOperations =
      input.fileOperations === undefined
        ? undefined
        : [...input.fileOperations]
            .map((operation) =>
              operation.kind === "move"
                ? {
                    ...operation,
                    path: normalizedPath(operation.path)!,
                    toPath: normalizedPath(operation.toPath)!,
                    evidenceIds:
                      operation.evidenceIds === undefined
                        ? undefined
                        : [...operation.evidenceIds].sort(),
                  }
                : {
                    ...operation,
                    path: normalizedPath(operation.path)!,
                    evidenceIds:
                      operation.evidenceIds === undefined
                        ? undefined
                        : [...operation.evidenceIds].sort(),
                  },
            )
            .sort(
              (left, right) =>
                left.projectId.localeCompare(right.projectId) ||
                left.path.localeCompare(right.path) ||
                left.kind.localeCompare(right.kind),
            )
    const snapshotHash = digest(canonicalJson(asJson({ projects, sources })))
    const provisional: TransformationPlan = {
      schemaVersion: 1,
      planId: "",
      ...input,
      projects,
      sources,
      snapshotHash,
      edits,
      evidence,
    }
    const finalizedBase =
      fileOperations !== undefined ? { ...provisional, fileOperations } : provisional
    return { ...finalizedBase, planId: digest(canonicalJson(withoutPlanId(finalizedBase))) }
  })
