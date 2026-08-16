/**
 * safemods CLI — Read-only Search & Audit Report Generator and Formatters.
 */
import { Data, Effect, Predicate } from "effect"
import type { Json, TransformationPlan } from "../internal/plan.ts"
import type {
  FileNotFound,
  ProjectNotInSnapshot,
  ProjectSnapshot,
  ProjectSnapshotError,
  WorkspaceSnapshotService,
} from "../Workspace/index.ts"
import { ANSI, colorize } from "./ansi.ts"

export interface AuditCriterionRecord {
  readonly criterion: string
  readonly facts: Readonly<Record<string, Json>>
}

export interface AuditFinding {
  readonly id: string
  readonly projectId: string
  readonly fileName: string
  readonly start: number
  readonly end: number
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
  readonly snippet?: string
  readonly criteria: ReadonlyArray<AuditCriterionRecord>
}

export interface AuditReport {
  readonly recipe: {
    readonly name: string
    readonly version: string
  }
  readonly totalMatches: number
  readonly totalFiles: number
  readonly findings: ReadonlyArray<AuditFinding>
}

export interface SourceLocation {
  readonly line: number
  readonly column: number
}

export class CliMatchFoundError extends Data.TaggedError("CliMatchFoundError")<{
  readonly matches: number
  readonly files: number
}> {}

/** Compute 1-based line number and 1-based character column from 0-based character offset. */
export const computeLineAndColumn = (
  text: string,
  pos: number,
): SourceLocation => {
  const clampedPos = Math.max(0, Math.min(pos, text.length))
  let line = 1
  let lastLineStart = 0
  for (let i = 0; i < clampedPos; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++
      lastLineStart = i + 1
    }
  }
  const column = clampedPos - lastLineStart + 1
  return { line, column }
}

/** Build structured AuditReport from a transformation plan and workspace snapshot. */
export const buildAuditReport = (
  plan: TransformationPlan,
  snapshot: WorkspaceSnapshotService,
): Effect.Effect<AuditReport, ProjectSnapshotError | ProjectNotInSnapshot | FileNotFound> =>
  Effect.gen(function*() {
    const findings: Array<AuditFinding> = []
    const projectCache = new Map<string, ProjectSnapshot>()

    for (const record of plan.evidence) {
      if (record.kind === "selection" && Predicate.isObject(record.facts)) {
        const facts = record.facts
        const projectId = Predicate.isString(facts.projectId)
          ? facts.projectId
          : plan.projects[0]?.id ?? "app"
        const fileName = Predicate.isString(facts.fileName) ? facts.fileName : ""
        const start = Predicate.isNumber(facts.start) ? facts.start : 0
        const end = Predicate.isNumber(facts.end) ? facts.end : start

        let project = projectCache.get(projectId)
        if (!project) {
          const config = snapshot.projects.find((p) => p.id === projectId)
          if (config) {
            project = yield* snapshot.project(config)
            projectCache.set(projectId, project)
          }
        }

        let sourceText = ""
        if (project && fileName) {
          sourceText = yield* project.sourceText(fileName).pipe(
            Effect.catchTag("FileNotFound", () => Effect.succeed("")),
          )
        }

        const startLoc = computeLineAndColumn(sourceText, start)
        const endLoc = computeLineAndColumn(sourceText, end)
        const snippet = sourceText !== "" ? sourceText.slice(start, end) : undefined

        const rawCriteria = Array.isArray(facts.criteria) ? facts.criteria : []
        const criteria: Array<AuditCriterionRecord> = []
        for (const item of rawCriteria) {
          if (Predicate.isObject(item) && "criterion" in item && Predicate.isString(item.criterion)) {
            // SAFETY: item.facts is treated as a JSON dictionary if present.
            const itemFacts = (Predicate.isObject(item.facts) ? item.facts : {}) as Record<string, Json>
            criteria.push({
              criterion: item.criterion,
              facts: itemFacts,
            })
          }
        }

        findings.push({
          id: record.id,
          projectId,
          fileName,
          start,
          end,
          startLine: startLoc.line,
          startColumn: startLoc.column,
          endLine: endLoc.line,
          endColumn: endLoc.column,
          snippet,
          criteria,
        })
      }
    }

    findings.sort((a, b) => {
      const cmpProject = a.projectId.localeCompare(b.projectId)
      if (cmpProject !== 0) return cmpProject
      const cmpFile = a.fileName.localeCompare(b.fileName)
      if (cmpFile !== 0) return cmpFile
      if (a.start !== b.start) return a.start - b.start
      if (a.end !== b.end) return a.end - b.end
      return a.id.localeCompare(b.id)
    })

    const uniqueFiles = new Set(findings.map((f) => `${f.projectId}\0${f.fileName}`))

    return {
      recipe: {
        name: plan.recipe.name,
        version: plan.recipe.version,
      },
      totalMatches: findings.length,
      totalFiles: uniqueFiles.size,
      findings,
    }
  })

/** Format AuditReport as Human-readable terminal text. */
export const renderAuditText = (
  report: AuditReport,
  options: { readonly color?: boolean } = {},
): string => {
  const useColor = options.color ?? true
  const lines: Array<string> = []

  lines.push(colorize(`Audit Report: ${report.recipe.name} [v${report.recipe.version}]`, ANSI.bold, useColor))
  lines.push(colorize(`Found ${report.totalMatches} match(es) across ${report.totalFiles} file(s)`, ANSI.dim, useColor))
  lines.push("")

  if (report.findings.length === 0) {
    lines.push(colorize("✔ No matches found.", ANSI.green, useColor))
    return lines.join("\n")
  }

  const grouped = new Map<string, Array<AuditFinding>>()
  for (const f of report.findings) {
    const key = `${f.projectId}:${f.fileName}`
    const existing = grouped.get(key)
    if (existing) {
      existing.push(f)
    } else {
      grouped.set(key, [f])
    }
  }

  for (const [fileKey, fileFindings] of grouped) {
    lines.push(colorize(`📄 ${fileKey}`, ANSI.bold + ANSI.cyan, useColor))
    for (const f of fileFindings) {
      const location = colorize(`  line ${f.startLine}:${f.startColumn}`, ANSI.yellow, useColor)
      const criteriaStr = f.criteria.length > 0
        ? colorize(` [${f.criteria.map((c) => c.criterion).join(", ")}]`, ANSI.dim, useColor)
        : ""
      lines.push(`${location}${criteriaStr}`)
      if (f.snippet) {
        const snippetLines = f.snippet.split("\n")
        const truncated = snippetLines.slice(0, 3).map((l) => `    ${l.trim()}`).join("\n")
        lines.push(colorize(truncated, ANSI.gray, useColor))
      }
    }
    lines.push("")
  }

  return lines.join("\n")
}

/** Format AuditReport as structured JSON string. */
export const renderAuditJson = (report: AuditReport): string =>
  JSON.stringify(report, null, 2)

const escapeCsv = (str: string): string => {
  if (str.includes(",") || str.includes("\"") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/** Format AuditReport as CSV table. */
export const renderAuditCsv = (report: AuditReport): string => {
  const header = "project,file,start_line,start_col,end_line,end_col,start_offset,end_offset,criteria,snippet"
  const rows = report.findings.map((f) => {
    const criteriaSummary = f.criteria.map((c) => c.criterion).join(";")
    const snippetClean = f.snippet ? f.snippet.replace(/\r?\n/g, " ") : ""
    return [
      escapeCsv(f.projectId),
      escapeCsv(f.fileName),
      f.startLine,
      f.startColumn,
      f.endLine,
      f.endColumn,
      f.start,
      f.end,
      escapeCsv(criteriaSummary),
      escapeCsv(snippetClean),
    ].join(",")
  })
  return [header, ...rows].join("\n")
}
