/**
 * Jev-scored compaction.
 *
 * The stock policy on a full context window is age. The oldest messages go
 * first, which removes the constraint stated at the start of the session and
 * the traceback that explains the current failure, while keeping the small
 * talk. This module replaces the ordering, not the mechanism. Every message
 * gets a value in [0, 1] from Jev, the highest values are kept verbatim until
 * the byte budget is spent, and the rest are replaced by a digest. Recency
 * survives as a tiebreaker and as the fallback when Jev is unreachable.
 *
 * @module dsh-plugin-jev-compaction/compact
 */

import { randomBytes } from 'node:crypto'
import { DEFAULT_ENDPOINT, DEFAULT_LEVELS, estimateCost } from './jev.js'
import { compilePins, DEFAULT_PIN_PATTERNS, matchPin, type CompiledPin } from './pins.js'
import { writeReceipt } from './receipt.js'
import { scoreSegments } from './scorer.js'
import { byteLength, clamp01, formatBytes, hashText, messageRole, messageText, oneLine, truncateBytes } from './text.js'
import type {
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

/** Output byte budget. 256 KiB leaves room for the next few turns. */
export const DEFAULT_TARGET_BYTES = 262144

/** Trailing messages always kept verbatim. */
export const DEFAULT_KEEP_RECENT = 4

/** Default task line sent to Jev when the caller does not supply one. */
export const DEFAULT_TASK = 'Continue the work in progress without losing information that later steps depend on.'

/** Score below which a message is kept out of caution. */
export const DEFAULT_MIN_CONFIDENCE = 0.35

/** Smallest digest worth writing. Below this the receipt is the only record. */
const MIN_DIGEST_BYTES = 48

/** Per-message excerpt bounds inside the digest. */
const MIN_EXCERPT_BYTES = 48
const MAX_EXCERPT_BYTES = 240

/** Generate a run identifier for receipts. */
function defaultRunId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/** Apply defaults and read the environment. */
export function resolveOptions(options: CompactOptions = {}): ResolvedOptions {
  const levels = Array.isArray(options.levels) && options.levels.length > 0 ? options.levels : DEFAULT_LEVELS
  return {
    targetBytes: Math.max(0, Math.floor(options.targetBytes ?? DEFAULT_TARGET_BYTES)),
    keepRecent: Math.max(0, Math.floor(options.keepRecent ?? DEFAULT_KEEP_RECENT)),
    batchSize: Math.max(1, Math.floor(options.batchSize ?? 8)),
    pinPatterns: Array.isArray(options.pinPatterns) ? options.pinPatterns.slice() : [],
    enablePinning: options.enablePinning !== false,
    pinFlags: options.pinFlags ?? 'i',
    minConfidence: clamp01(options.minConfidence ?? DEFAULT_MIN_CONFIDENCE),
    summaryBytes: Math.max(0, Math.floor(options.summaryBytes ?? 1024)),
    summaryRole: options.summaryRole ?? 'system',
    stateMessageBytes: Math.max(1, Math.floor(options.stateMessageBytes ?? 2000)),
    endpoint: options.endpoint ?? process.env.JEV_API_URL ?? DEFAULT_ENDPOINT,
    apiKey: options.apiKey ?? process.env.JEV_API_KEY ?? '',
    timeoutMs: Math.max(1, Math.floor(options.timeoutMs ?? 15000)),
    levels,
    pricePerMillionTokens: Math.max(0, options.pricePerMillionTokens ?? 0.1),
    receiptPath: options.receiptPath ?? process.env.DSH_JEV_COMPACT_RECEIPT ?? '',
    task: options.task ?? DEFAULT_TASK,
    runId: options.runId ?? defaultRunId(),
    scoreCache: options.scoreCache,
  }
}

/** Reduce one message to a segment. */
export function toSegment(message: Message, index: number): Segment {
  const text = messageText(message)
  return {
    index,
    role: messageRole(message),
    text,
    bytes: byteLength(text),
    hash: hashText(text),
    message,
    empty: oneLine(text).length === 0,
  }
}

/** A candidate plus its resolved value. */
interface Ranked {
  segment: Segment
  value: number
  confidence: number
  source: ScoreSource
  doubt: boolean
}

/** Greedy selection over a ranked list. */
function selectGreedy(ranked: Ranked[], budget: number): { kept: Set<number>; keptBytes: number; dropped: Ranked[] } {
  const kept = new Set<number>()
  const dropped: Ranked[] = []
  let keptBytes = 0
  for (const item of ranked) {
    if (keptBytes + item.segment.bytes <= budget) {
      kept.add(item.segment.index)
      keptBytes += item.segment.bytes
    } else {
      dropped.push(item)
    }
  }
  return { kept, keptBytes, dropped }
}

/**
 * Build the digest that replaces dropped messages.
 *
 * The digest is extractive: it quotes the highest-value omitted messages in
 * value order until the byte budget is spent. It is deliberately deterministic
 * and local, so compaction never depends on a second model call.
 */
export function buildDigest(
  dropped: Ranked[],
  budget: number,
  runId: string,
  role: string,
): Message | null {
  if (dropped.length === 0 || budget <= 0) return null

  const droppedBytes = dropped.reduce((total, item) => total + item.segment.bytes, 0)
  const header = `[jev-compaction] ${dropped.length} messages elided (${formatBytes(droppedBytes)}). Highest-value omitted content follows.`
  let out = truncateBytes(header, budget)

  for (let i = 0; i < dropped.length; i += 1) {
    const item = dropped[i]
    const prefix = `\n- ${item.segment.role} (value ${item.value.toFixed(2)}): `
    const room = budget - byteLength(out) - byteLength(prefix)
    if (room < 16) break
    // Spread the remaining room over the next few messages rather than
    // spending all of it on the first one, so the digest covers more of what
    // was cut instead of quoting a single message at length.
    const share = Math.max(MIN_EXCERPT_BYTES, Math.min(MAX_EXCERPT_BYTES, Math.floor(room / Math.min(dropped.length - i, 4))))
    const excerpt = truncateBytes(oneLine(item.segment.text), Math.min(room, share))
    if (excerpt.length === 0) continue
    out += prefix + excerpt
  }

  return {
    role,
    content: out,
    jevCompaction: {
      runId,
      elided: dropped.length,
      elidedBytes: droppedBytes,
      digestBytes: byteLength(out),
    },
  }
}

/**
 * Compact a message list against a byte budget.
 *
 * Never throws. If Jev is unreachable the ordering degrades to recency and the
 * run still produces a valid, smaller message list.
 */
export async function compactMessages(
  messages: Message[],
  task?: string,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now()
  const opts = resolveOptions(task === undefined ? options : { ...options, task })
  const segments = messages.map((message, index) => toSegment(message, index))
  const bytesBefore = segments.reduce((total, segment) => total + segment.bytes, 0)

  const pins: CompiledPin[] = opts.enablePinning
    ? compilePins([...DEFAULT_PIN_PATTERNS, ...opts.pinPatterns], opts.pinFlags)
    : []
  for (const segment of segments) {
    const pin = matchPin(pins, segment)
    if (pin !== undefined) segment.pin = pin
  }

  const decisions = new Map<number, Decision>()
  const decide = (
    segment: Segment,
    kept: boolean,
    reason: string,
    source: Decision['source'],
    score?: ValueScore,
  ): void => {
    decisions.set(segment.index, {
      index: segment.index,
      role: segment.role,
      hash: segment.hash,
      bytes: segment.bytes,
      value: score ? score.value : null,
      confidence: score ? score.confidence : null,
      source,
      kept,
      reason,
    })
  }

  const finish = async (output: Message[], extra: Partial<CompactStats>): Promise<CompactResult> => {
    const ordered = segments
      .map(segment => decisions.get(segment.index))
      .filter((decision): decision is Decision => decision !== undefined)
    const stats: CompactStats = {
      messages: segments.length,
      kept: ordered.filter(d => d.kept).length,
      dropped: ordered.filter(d => !d.kept).length,
      bytesBefore,
      bytesAfter: output.reduce((total, message) => total + byteLength(messageText(message)), 0),
      targetBytes: opts.targetBytes,
      overBudgetBytes: 0,
      jevCalls: 0,
      jevStateBytes: 0,
      failedBatches: 0,
      estimatedCost: 0,
      fallback: false,
      degraded: false,
      durationMs: 0,
      runId: opts.runId,
      receiptWritten: false,
      ...extra,
    }
    stats.durationMs = Date.now() - started
    return { messages: output, decisions: ordered, stats }
  }

  // Nothing to do. Returning the input untouched keeps the common case free.
  if (bytesBefore <= opts.targetBytes) {
    for (const segment of segments) decide(segment, true, 'under-budget', 'policy')
    return finish(messages, {})
  }

  // Protected messages are kept verbatim whatever they score.
  const protectedIndexes = new Set<number>()
  let protectedBytes = 0
  const candidates: Segment[] = []

  for (const segment of segments) {
    let reason: string | undefined
    let source: Decision['source'] = 'policy'
    if (segment.role === 'system') reason = 'system-message'
    else if (segment.index >= segments.length - opts.keepRecent) reason = 'recent-window'
    else if (segment.pin !== undefined) {
      reason = 'pin-match'
      source = 'pin'
    } else if (segment.empty) reason = 'empty-message'

    if (reason === 'empty-message') {
      decide(segment, false, reason, 'policy', { value: 0, confidence: 1, source: 'policy' })
      continue
    }
    if (reason !== undefined) {
      protectedIndexes.add(segment.index)
      protectedBytes += segment.bytes
      decide(segment, true, reason, source)
      continue
    }
    candidates.push(segment)
  }

  const remaining = opts.targetBytes - protectedBytes

  // No candidate is scored when the protected set already fills the budget.
  let ranked: Ranked[] = []
  let outcome = {
    calls: 0,
    stateBytes: 0,
    failedBatches: 0,
    fallback: false,
    errors: [] as string[],
  }

  if (candidates.length > 0 && remaining > 0) {
    const scored = await scoreSegments(candidates, opts, segments.length)
    outcome = {
      calls: scored.calls,
      stateBytes: scored.stateBytes,
      failedBatches: scored.failedBatches,
      fallback: scored.fallback,
      errors: scored.errors,
    }
    ranked = candidates.map(segment => {
      const score = scored.scores.get(segment.index) ?? { value: 0, confidence: 1, source: 'policy' as const }
      // A low-confidence answer is not evidence that the message is
      // disposable. Doubt resolves toward keeping context.
      const doubt = score.confidence < opts.minConfidence
      return {
        segment,
        value: doubt ? 1 : score.value,
        confidence: score.confidence,
        source: score.source,
        doubt,
      }
    })
    ranked.sort((a, b) => b.value - a.value || b.segment.index - a.segment.index)
  } else if (candidates.length > 0) {
    for (const segment of candidates) {
      decide(segment, false, 'budget-exhausted', 'policy', { value: 0, confidence: 1, source: 'policy' })
    }
  }

  // Selection runs twice. The first pass ignores the digest, so a list that
  // fits as is never loses bytes to a summary it does not need. If something
  // had to be dropped, the digest is reserved at a quarter of the remaining
  // budget, capped by summaryBytes, and selection runs again over the rest.
  // A message kept verbatim is more useful than an excerpt of it, so the
  // digest never takes more than that share.
  let digestBytes = 0
  let selection = { kept: new Set<number>(), keptBytes: 0, dropped: [] as Ranked[] }
  if (ranked.length > 0) {
    selection = selectGreedy(ranked, Math.max(0, remaining))
    if (selection.dropped.length > 0 && remaining > 0) {
      digestBytes = Math.min(opts.summaryBytes, Math.floor(remaining / 4))
      // Below a few dozen bytes a digest carries no readable information.
      if (digestBytes < MIN_DIGEST_BYTES) digestBytes = 0
      selection = selectGreedy(ranked, Math.max(0, remaining - digestBytes))
    }
  }

  const droppedByIndex = new Map<number, Ranked>()
  for (const item of selection.dropped) droppedByIndex.set(item.segment.index, item)

  const digest =
    droppedByIndex.size > 0
      ? buildDigest(selection.dropped, digestBytes, opts.runId, opts.summaryRole)
      : null

  for (const item of ranked) {
    const kept = selection.kept.has(item.segment.index)
    const reason = kept ? (item.doubt ? 'doubt-keep' : 'high-value') : 'budget-exhausted'
    decide(item.segment, kept, reason, item.source, {
      value: item.value,
      confidence: item.confidence,
      source: item.source,
    })
  }

  // Assemble: kept messages verbatim, dropped runs replaced by one digest
  // placed where the first dropped message sat.
  const keptSet = new Set<number>([...protectedIndexes, ...selection.kept])
  const output: Message[] = []
  let digestPlaced = false
  for (const segment of segments) {
    if (keptSet.has(segment.index)) {
      output.push(segment.message)
    } else if (digest && !digestPlaced) {
      output.push(digest)
      digestPlaced = true
    }
  }

  const bytesAfter = output.reduce((total, message) => total + byteLength(messageText(message)), 0)
  const result = await finish(output, {
    overBudgetBytes: Math.max(0, bytesAfter - opts.targetBytes),
    jevCalls: outcome.calls,
    jevStateBytes: outcome.stateBytes,
    failedBatches: outcome.failedBatches,
    estimatedCost: Number(estimateCost(outcome.stateBytes, opts.pricePerMillionTokens).toFixed(6)),
    fallback: outcome.fallback,
    degraded: outcome.failedBatches > 0 && !outcome.fallback,
  })

  if (opts.receiptPath) {
    result.stats.receiptWritten = await writeReceipt(opts.receiptPath, result, opts.task)
  }
  return result
}
