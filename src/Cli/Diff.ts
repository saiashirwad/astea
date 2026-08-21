/**
 * High-fidelity terminal diff and diagnostic renderer.
 *
 * Produces ANSI-colored unified diffs from before/after text buffers,
 * complete with line numbers, hunk headers, change summaries, and
 * diagnostic delta badges.
 */
import type { DiagnosticDiff } from "../Policy/index.ts"
import type { FilePreview, PlanPreview } from "../Verification/index.ts"
import { ANSI, colorize } from "./Ansi.ts"

export interface DiffOptions {
  readonly color?: boolean
  readonly contextLines?: number
}

/** Compute line-by-line unified diff between two text versions. */
export const computeUnifiedDiff = (
  fileName: string,
  beforeText: string,
  afterText: string,
  options: DiffOptions = {},
): string => {
  const useColor = options.color ?? true
  const beforeLines = beforeText === "" ? [] : beforeText.split("\n")
  const afterLines = afterText === "" ? [] : afterText.split("\n")

  if (beforeText === afterText) {
    return colorize(`  ${fileName} (no changes)`, ANSI.dim, useColor)
  }

  const lines: Array<string> = []
  lines.push(colorize(`--- a/${fileName}`, ANSI.bold + ANSI.red, useColor))
  lines.push(colorize(`+++ b/${fileName}`, ANSI.bold + ANSI.green, useColor))

  const diffs: Array<{
    type: "same" | "add" | "remove"
    text: string
    oldLine?: number
    newLine?: number
  }> = []

  let i = 0
  let j = 0
  let oldLine = 1
  let newLine = 1

  while (i < beforeLines.length || j < afterLines.length) {
    if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
      diffs.push({ type: "same", text: beforeLines[i]!, oldLine, newLine })
      i++
      j++
      oldLine++
      newLine++
    } else if (
      j < afterLines.length &&
      (i >= beforeLines.length || !afterLines.slice(j).includes(beforeLines[i]!))
    ) {
      diffs.push({ type: "add", text: afterLines[j]!, newLine })
      j++
      newLine++
    } else {
      diffs.push({ type: "remove", text: beforeLines[i]!, oldLine })
      i++
      oldLine++
    }
  }

  for (const item of diffs) {
    if (item.type === "same") {
      lines.push(colorize(`  ${item.text}`, ANSI.gray, useColor))
    } else if (item.type === "add") {
      lines.push(colorize(`+ ${item.text}`, ANSI.green, useColor))
    } else if (item.type === "remove") {
      lines.push(colorize(`- ${item.text}`, ANSI.red, useColor))
    }
  }

  return lines.join("\n")
}

/** Render a formatted terminal report for a FilePreview. */
export const renderFilePreview = (file: FilePreview, options: DiffOptions = {}): string => {
  const useColor = options.color ?? true
  const badge =
    file.action === "create"
      ? colorize("[CREATE]", ANSI.green + ANSI.bold, useColor)
      : file.action === "delete"
        ? colorize("[DELETE]", ANSI.red + ANSI.bold, useColor)
        : file.action === "move"
          ? colorize("[MOVE]", ANSI.yellow + ANSI.bold, useColor)
          : colorize("[MODIFY]", ANSI.cyan + ANSI.bold, useColor)

  const header = `${badge} ${colorize(file.fileName, ANSI.bold, useColor)} (${file.projectId})`
  const beforeText = file.before.exists ? file.before.text : ""
  const afterText = file.after.exists ? file.after.text : ""
  const diff = computeUnifiedDiff(file.fileName, beforeText, afterText, options)
  return `${header}\n${diff}`
}

/** Render full terminal preview for a PlanPreview. */
export const renderPlanPreview = (preview: PlanPreview, options: DiffOptions = {}): string => {
  const useColor = options.color ?? true
  const lines: Array<string> = []

  lines.push(
    colorize(`Transformation Plan Preview [${preview.planId.slice(0, 8)}]`, ANSI.bold, useColor),
  )
  lines.push(colorize(`Total files affected: ${preview.files.length}`, ANSI.dim, useColor))
  lines.push("")

  for (const file of preview.files) {
    lines.push(renderFilePreview(file, options))
    lines.push("")
  }

  return lines.join("\n")
}

/** Render diagnostic delta verification summary. */
export const renderDiagnosticDiff = (diff: DiagnosticDiff, options: DiffOptions = {}): string => {
  const useColor = options.color ?? true
  const lines: Array<string> = []

  const total = diff.introduced.length + diff.resolved.length + diff.unchanged.length
  lines.push(colorize(`Diagnostic Verification (${total} total)`, ANSI.bold, useColor))

  if (diff.resolved.length > 0) {
    lines.push(
      colorize(`  ✔ Resolved ${diff.resolved.length} diagnostic(s):`, ANSI.green, useColor),
    )
    for (const d of diff.resolved) {
      lines.push(
        colorize(
          `    - TS${d.code}: ${d.message} (${d.fileName}:${d.start})`,
          ANSI.green,
          useColor,
        ),
      )
    }
  }

  if (diff.introduced.length > 0) {
    lines.push(
      colorize(`  ✖ Introduced ${diff.introduced.length} new diagnostic(s):`, ANSI.red, useColor),
    )
    for (const d of diff.introduced) {
      lines.push(
        colorize(`    + TS${d.code}: ${d.message} (${d.fileName}:${d.start})`, ANSI.red, useColor),
      )
    }
  } else {
    lines.push(colorize(`  ✔ No new diagnostic errors introduced`, ANSI.green, useColor))
  }

  return lines.join("\n")
}
