/** Shared terminal styling tokens. */
export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
} as const

export const colorize = (text: string, color: string, enabled = true): string =>
  enabled ? `${color}${text}${ANSI.reset}` : text
