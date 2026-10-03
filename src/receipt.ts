/**
 * Decision receipts.
 *
 * A receipt is one JSON line per message plus a summary line for the run. It
 * records the hash, the score, the confidence, whether the message survived,
 * and why. Two things follow from that. Compaction becomes auditable after the
 * fact, and the scores can be replayed through a different budget or
 * confidence threshold at zero inference cost, because the expensive part was
 * the scoring and it is already written down.
 *
 * @module dsh-plugin-jev-compaction/receipt
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { CompactResult, CompactStats, ValueScore } from './types.js'

/** One line of a receipts file. */
export interface ReceiptEntry {
  kind: 'decision' | 'summary'
  runId: string
  ts: string
  task?: string
  index?: number
  role?: string
  hash?: string
  bytes?: number
  value?: number | null
  confidence?: number | null
  source?: string
  kept?: boolean
  reason?: string
  stats?: CompactStats
}

/** Decisions grouped by run. */
export interface ReceiptRun {
  runId: string
  ts: string
  task?: string
  decisions: ReceiptEntry[]
  stats?: CompactStats
}

/**
 * Append a run to a receipts file.
 * Returns false rather than throwing, because an unwritable receipt path must
 * not fail a compaction.
 */
export async function writeReceipt(
  path: string,
  result: CompactResult,
  task: string,
): Promise<boolean> {
  if (!path) return false
  const target = resolve(path)
  const ts = new Date().toISOString()
  const runId = result.stats.runId
  const lines: string[] = []

  for (const decision of result.decisions) {
    lines.push(JSON.stringify({
      kind: 'decision',
      runId,
      ts,
      task,
      index: decision.index,
      role: decision.role,
      hash: decision.hash,
      bytes: decision.bytes,
      value: decision.value,
      confidence: decision.confidence,
      source: decision.source,
      kept: decision.kept,
      reason: decision.reason,
    } satisfies ReceiptEntry))
  }

  lines.push(JSON.stringify({ kind: 'summary', runId, ts, task, stats: result.stats } satisfies ReceiptEntry))

  try {
    await mkdir(dirname(target), { recursive: true })
    await appendFile(target, lines.join('\n') + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** Read and parse a receipts file, skipping lines that do not parse. */
export async function readReceipts(path: string): Promise<ReceiptEntry[]> {
  const text = await readFile(resolve(path), 'utf8')
  const entries: ReceiptEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed) as ReceiptEntry
      if (parsed && typeof parsed === 'object' && typeof parsed.runId === 'string') {
        entries.push(parsed.kind ? parsed : { ...parsed, kind: 'decision' })
      }
    } catch {
      /* a truncated tail line is expected when a run is still writing */
    }
  }
  return entries
}

/** Group receipt entries by run, most recent run last. */
export function groupRuns(entries: ReceiptEntry[]): ReceiptRun[] {
  const runs = new Map<string, ReceiptRun>()
  for (const entry of entries) {
    let run = runs.get(entry.runId)
    if (!run) {
      run = { runId: entry.runId, ts: entry.ts, task: entry.task, decisions: [] }
      runs.set(entry.runId, run)
    }
    if (entry.kind === 'summary') {
      run.stats = entry.stats
    } else {
      run.decisions.push(entry)
    }
    if (entry.ts > run.ts) run.ts = entry.ts
  }
  return [...runs.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
}

/**
 * Rebuild a score cache keyed by content hash from the most recent run that
 * scored anything. Replay matches on hash rather than position so it survives
 * a message list that has shifted since the receipt was written.
 */
export function loadScoreCache(entries: ReceiptEntry[]): Map<string, ValueScore> {
  const cache = new Map<string, ValueScore>()
  const runs = groupRuns(entries)
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    let found = false
    for (const decision of runs[i].decisions) {
      if (typeof decision.hash !== 'string') continue
      if (typeof decision.value !== 'number' || typeof decision.confidence !== 'number') continue
      if (decision.source !== 'jev' && decision.source !== 'cache') continue
      cache.set(decision.hash, { value: decision.value, confidence: decision.confidence, source: 'cache' })
      found = true
    }
    if (found) return cache
  }
  return cache
}
