/**
 * Message scoring.
 *
 * Messages are packed into batches and each batch becomes one state block.
 * Jev is asked one question per message in the block, so a batch of eight
 * costs one request rather than eight. Anything that fails is scored by
 * recency, which is the behaviour the harness already had.
 *
 * @module dsh-plugin-jev-compaction/scorer
 */

import { askJev, JevError, type JevClientOptions } from './jev.js'
import { byteLength, truncateBytes } from './text.js'
import type { ResolvedOptions, Segment, ValueScore } from './types.js'

/** Outcome of scoring a candidate set. */
export interface ScoreOutcome {
  /** Scores keyed by segment index. Every candidate gets one. */
  scores: Map<number, ValueScore>
  /** Requests actually sent. */
  calls: number
  /** Bytes of state sent. */
  stateBytes: number
  /** Batches that failed and were scored by recency. */
  failedBatches: number
  /** True when no batch reached the endpoint. */
  fallback: boolean
  /** Human-readable reasons for failed batches. */
  errors: string[]
}

/**
 * Recency rank of a message in [0, 1], newest highest.
 * This is the ordering the harness already uses, and the value every fallback
 * path assigns.
 */
export function recencyValue(index: number, messageCount: number): number {
  if (messageCount <= 1) return 1
  return index / (messageCount - 1)
}

/** Render the state block for a batch. */
export function renderState(batch: Segment[], task: string, stateMessageBytes: number): string {
  const lines: string[] = [
    `Task: ${task}`,
    'Guidance: keep messages that later steps depend on, such as stated constraints, decisions, file paths, error text, and results still in use.',
    '',
  ]
  for (const segment of batch) {
    lines.push(`[${segment.index} | ${segment.role}]`)
    lines.push(truncateBytes(segment.text, stateMessageBytes))
    lines.push('')
  }
  return lines.join('\n')
}

/** One question per message in the batch. */
export function questionsFor(batch: Segment[]): string[] {
  return batch.map(s => `How much does message [${s.index}] matter for completing the task?`)
}

/** Split candidates into batches. */
export function batchSegments(candidates: Segment[], batchSize: number): Segment[][] {
  const size = Math.max(1, Math.floor(batchSize))
  const batches: Segment[][] = []
  for (let i = 0; i < candidates.length; i += size) {
    batches.push(candidates.slice(i, i + size))
  }
  return batches
}

/**
 * Score candidates with Jev, degrading to recency per failed batch.
 *
 * `messageCount` is the size of the full message list, so recency is measured
 * on one scale for the whole run. The function never throws. Whatever the
 * endpoint does, every candidate comes back with a value, so the caller can
 * always finish a compaction run.
 */
export async function scoreSegments(
  candidates: Segment[],
  options: ResolvedOptions,
  messageCount: number,
): Promise<ScoreOutcome> {
  const scores = new Map<number, ValueScore>()
  const outcome: ScoreOutcome = {
    scores,
    calls: 0,
    stateBytes: 0,
    failedBatches: 0,
    fallback: false,
    errors: [],
  }

  if (candidates.length === 0) return outcome

  const useRecency = (segment: Segment): void => {
    scores.set(segment.index, {
      value: recencyValue(segment.index, messageCount),
      confidence: 1,
      source: 'age',
    })
  }

  // A replay cache means the caller wants recorded scores, not new inference.
  if (options.scoreCache) {
    for (const segment of candidates) {
      const cached = options.scoreCache.get(segment.hash)
      if (cached) {
        scores.set(segment.index, { value: cached.value, confidence: cached.confidence, source: 'cache' })
      } else {
        outcome.failedBatches += 1
        useRecency(segment)
      }
    }
    outcome.fallback = outcome.failedBatches === candidates.length
    return outcome
  }

  // Without a key there is nothing to try, so skip the network entirely.
  if (!options.apiKey) {
    outcome.fallback = true
    outcome.errors.push('missing-key: JEV_API_KEY is not set')
    candidates.forEach(useRecency)
    return outcome
  }

  const client: JevClientOptions = {
    endpoint: options.endpoint,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
    levels: options.levels,
  }

  const batches = batchSegments(candidates, options.batchSize)
  for (const batch of batches) {
    const state = renderState(batch, options.task, options.stateMessageBytes)
    outcome.stateBytes += byteLength(state)
    try {
      const answers = await askJev(client, state, questionsFor(batch))
      outcome.calls += 1
      batch.forEach((segment, i) => {
        const answer = answers[i]
        scores.set(segment.index, {
          value: answer.value,
          confidence: answer.confidence,
          source: 'jev',
        })
      })
    } catch (error) {
      outcome.calls += 1
      outcome.failedBatches += 1
      const code = error instanceof JevError ? error.code : 'network'
      const message = error instanceof Error ? error.message : String(error)
      if (outcome.errors.length < 8) outcome.errors.push(`${code}: ${message}`)
      batch.forEach(useRecency)
    }
  }

  outcome.fallback = batches.length > 0 && outcome.failedBatches === batches.length
  return outcome
}
