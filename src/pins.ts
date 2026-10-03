/**
 * Pin patterns.
 *
 * A pin is a cheap, deterministic second opinion that overrides the score.
 * The defaults cover the artifacts that are expensive to rediscover and
 * useless once lost: paths that were already resolved, tracebacks that explain
 * a failure, error codes, URLs, and constraints the user stated outright.
 *
 * Patterns are compiled with the `i` flag by default. Every default below is
 * written so that case-insensitivity only widens a match, which errs toward
 * keeping context.
 *
 * @module dsh-plugin-jev-compaction/pins
 */

import type { Segment } from './types.js'

/**
 * Built-in pin patterns. Each entry is a regular expression source string.
 */
export const DEFAULT_PIN_PATTERNS: string[] = [
  // File paths with a source or data extension, at least one directory deep.
  '(?:[A-Za-z]:[\\\\/]|\\.{0,2}/)?(?:[\\w.-]+[\\\\/])+[\\w.-]+\\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|sh|sql|json|jsonl|ya?ml|toml|ini|csv|tsv|md|txt|log|c|cc|cpp|hpp|h)\\b',
  // Python tracebacks, Python stack frames, and JavaScript stack frames.
  '(?:traceback \\(most recent call last\\)|(?:^|\\n)\\s*file "[^"]+", line \\d+|(?:^|\\n)\\s*at [\\w.$<>\\[\\]]+\\([^)]*:\\d+(?::\\d+)?\\)|(?:^|\\n)\\s*at [\\w.$<>\\[\\]]+:\\d+:\\d+)',
  // Error codes, errno-style constants, hex codes, and HTTP statuses.
  '\\b(?:[A-Z]{2,}\\d{2,}[A-Z0-9]*|[A-Z]{2,}_[A-Z0-9]*\\d[A-Z0-9_]*|0x[0-9A-F]{4,})\\b|(?:status|statuscode|status_code|code|http(?:/\\d(?:\\.\\d)?)?)[\\s:=]+[45]\\d{2}\\b|\\b[45]\\d{2} (?:bad request|unauthorized|forbidden|not found|conflict|too many requests|internal server error|bad gateway|service unavailable)\\b',
  // URLs and endpoints.
  'https?://[^\\s<>"\'`)\\]]+',
  // Constraints and standing instructions stated by the user, at the start of
  // a line or of a sentence. The labelled markers require their colon so that
  // ordinary prose beginning with "note" does not pin the whole message.
  '(?:^|\\n|[.;:]\\s)\\s*(?:[-*]\\s*)?(?:you (?:must|should not|never)|must not|do not|never |always |remember to|keep in mind|mandatory|constraints?:|requirements?:|important:|note:)[^\\n]{0,200}',
]

/** A compiled pin. */
export interface CompiledPin {
  source: string
  regex: RegExp
}

/**
 * Compile the built-in defaults plus any user patterns. An invalid user
 * pattern is skipped rather than thrown, because a typo in a pin should not
 * take down compaction.
 */
export function compilePins(
  patterns: string[],
  flags: string,
  onError?: (pattern: string, error: Error) => void,
): CompiledPin[] {
  const compiled: CompiledPin[] = []
  for (const source of patterns) {
    try {
      compiled.push({ source, regex: new RegExp(source, flags) })
    } catch (error) {
      if (onError) onError(source, error instanceof Error ? error : new Error(String(error)))
    }
  }
  return compiled
}

/** Return the first pin whose pattern matches the segment text, if any. */
export function matchPin(pins: CompiledPin[], segment: Segment): string | undefined {
  if (segment.empty) return undefined
  for (const pin of pins) {
    // Patterns carry the `g` flag only when the user asks for it, and a shared
    // regex with `lastIndex` would be stateful across calls, so reset first.
    pin.regex.lastIndex = 0
    if (pin.regex.test(segment.text)) return pin.source
  }
  return undefined
}
