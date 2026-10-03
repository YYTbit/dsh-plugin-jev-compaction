/**
 * Jev Compaction Plugin for DeepSeek Harness.
 *
 * Replaces age-based context truncation with value-based compaction. Every
 * message is scored by TypeSafe System One for how much it matters to the
 * current task, the highest values are kept verbatim until the byte budget is
 * spent, and the rest are replaced by an extractive digest. When the endpoint
 * is unreachable the plugin degrades to the recency ordering the harness
 * already had.
 *
 * @module dsh-plugin-jev-compaction
 */

import { compactMessages, resolveOptions } from './compact.js'
import type { CompactOptions, Message } from './types.js'

export const name = 'jev-compaction'
export const inject = ['systemPrompt']

/** Plugin configuration. Every field is optional. */
export type Config = CompactOptions

/** Policy note injected into the system prompt. */
export const POLICY_CONTENT = `# Jev Compaction

This session compacts its context by value, not by age. When the conversation
grows past the byte budget, each message is scored for how much it matters to
the current task. High-value messages are kept verbatim and the remainder is
replaced by a digest that quotes the best of what was cut.

What follows from that:

- Constraints, decisions and results stated early survive, so they can be relied on.
- File paths, tracebacks, error codes, URLs and explicit requirements are kept whatever they score.
- A tool result that is no longer in context was scored as spent. Re-read the file or re-run the command instead of reconstructing it from memory.
`

/**
 * Signature of a compaction hook host. DeepSeek Harness builds on cordis, and
 * a service that owns the compaction path would expose a `register` method.
 * The plugin probes for it and also works as a plain library when the service
 * is absent, which is why the core function is exported separately.
 */
interface CompactionHookHost {
  register?: (hook: {
    name: string
    compact: (messages: Message[], task?: string) => Promise<unknown>
  }) => unknown
}

export function apply(ctx: any, config: Config = {}): void {
  const options = resolveOptions(config)

  // Tell the model what survives compaction and what does not.
  if (ctx.systemPrompt?.section) {
    ctx.systemPrompt.section({
      name: 'jev-compaction:policy',
      order: 150,
      text: async () => POLICY_CONTENT,
    })
  }

  // Register with the compaction service when the harness exposes one.
  const hookHost: CompactionHookHost | undefined = ctx.compaction ?? ctx.prune
  if (hookHost && typeof hookHost.register === 'function') {
    hookHost.register({
      name: 'jev-compaction',
      compact: (messages: Message[], task?: string) => compactMessages(messages, task, config),
    })
  }

  // Publish the non-secret settings so shell commands can read the effective
  // configuration. The API key is deliberately not registered.
  if (ctx.shellEnv?.register) {
    ctx.shellEnv.register({
      name: 'jev-compaction',
      variables: {
        'DSH_JEV_COMPACT_RECEIPT': { description: 'Path to the compaction decision receipts file' },
        'JEV_API_URL': { description: 'TypeSafe System One endpoint used for message scoring' },
      },
      resolve() {
        return {
          'DSH_JEV_COMPACT_RECEIPT': options.receiptPath,
          'JEV_API_URL': options.endpoint,
        }
      },
    })
  }
}

export { compactMessages, resolveOptions, toSegment, buildDigest } from './compact.js'
export { askJev, probeEndpoint, estimateCost, JevError, DEFAULT_ENDPOINT, DEFAULT_LEVELS } from './jev.js'
export { DEFAULT_PIN_PATTERNS, compilePins, matchPin } from './pins.js'
export { scoreSegments, renderState, recencyValue } from './scorer.js'
export { writeReceipt, readReceipts, groupRuns, loadScoreCache } from './receipt.js'
export type { ReceiptEntry, ReceiptRun } from './receipt.js'
export type { JevAnswer, JevClientOptions, JevErrorCode } from './jev.js'
export type { ScoreOutcome } from './scorer.js'
export type {
  CompactOptions,
  CompactResult,
  CompactStats,
  Decision,
  Message,
  ResolvedOptions,
  ScoreSource,
  Segment,
  ValueScore,
} from './types.js'

export default { name, inject, apply }
