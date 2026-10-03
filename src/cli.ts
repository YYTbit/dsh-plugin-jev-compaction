#!/usr/bin/env node
/**
 * jev-compact -- Jev-scored context compaction CLI.
 *
 * Usage:
 *   jev-compact score <file.jsonl>     Score messages, print a value table
 *   jev-compact compact <file.jsonl>   Compact a conversation, JSONL on stdout
 *   jev-compact receipts <path>        Summarise a decision receipts file
 *   jev-compact doctor                 Check endpoint, key and effective config
 *
 * @module dsh-plugin-jev-compaction/cli
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { compactMessages, resolveOptions, toSegment } from './compact.js'
import { DEFAULT_PIN_PATTERNS } from './pins.js'
import { estimateCost, probeEndpoint, askJev } from './jev.js'
import { groupRuns, loadScoreCache, readReceipts } from './receipt.js'
import { scoreSegments } from './scorer.js'
import { formatBytes, truncateBytes } from './text.js'
import type { CompactOptions, CompactStats, Message, ResolvedOptions } from './types.js'

interface ParsedArgs {
  positional: string[]
  flags: Map<string, string[]>
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>()
  const positional: string[] = []
  const push = (key: string, value: string): void => {
    const list = flags.get(key)
    if (list) list.push(value)
    else flags.set(key, [value])
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq >= 0) {
      push(token.slice(2, eq), token.slice(eq + 1))
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      push(key, 'true')
    } else {
      push(key, next)
      i += 1
    }
  }
  return { positional, flags }
}

function flagString(args: ParsedArgs, key: string): string | undefined {
  const list = args.flags.get(key)
  return list && list.length > 0 ? list[list.length - 1] : undefined
}

function flagNumber(args: ParsedArgs, key: string, fallback: number): number {
  const raw = flagString(args, key)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`--${key} expects a number, received "${raw}"`)
  }
  return value
}

function flagBool(args: ParsedArgs, key: string): boolean {
  const raw = flagString(args, key)
  return raw !== undefined && raw !== 'false'
}

/** Turn command line flags into plugin options. */
function optionsFromArgs(args: ParsedArgs, base: CompactOptions = {}): CompactOptions {
  const options: CompactOptions = { ...base }
  const targetBytes = flagString(args, 'target-bytes')
  if (targetBytes !== undefined) options.targetBytes = flagNumber(args, 'target-bytes', 0)
  if (flagString(args, 'keep-recent') !== undefined) options.keepRecent = flagNumber(args, 'keep-recent', 4)
  if (flagString(args, 'batch-size') !== undefined) options.batchSize = flagNumber(args, 'batch-size', 8)
  if (flagString(args, 'min-confidence') !== undefined) options.minConfidence = flagNumber(args, 'min-confidence', 0.35)
  if (flagString(args, 'summary-bytes') !== undefined) options.summaryBytes = flagNumber(args, 'summary-bytes', 1024)
  if (flagString(args, 'state-message-bytes') !== undefined) {
    options.stateMessageBytes = flagNumber(args, 'state-message-bytes', 2000)
  }
  if (flagString(args, 'timeout') !== undefined) options.timeoutMs = flagNumber(args, 'timeout', 15000)
  if (flagString(args, 'price') !== undefined) options.pricePerMillionTokens = flagNumber(args, 'price', 0.1)
  const receipt = flagString(args, 'receipt')
  if (receipt !== undefined) options.receiptPath = receipt
  const task = flagString(args, 'task')
  if (task !== undefined) options.task = task
  const endpoint = flagString(args, 'endpoint')
  if (endpoint !== undefined) options.endpoint = endpoint
  const levels = flagString(args, 'levels')
  if (levels !== undefined) options.levels = levels.split(',').map(part => part.trim()).filter(Boolean)
  const extraPins = args.flags.get('pin')
  if (extraPins) options.pinPatterns = [...(options.pinPatterns ?? []), ...extraPins]
  if (flagBool(args, 'no-pin')) options.enablePinning = false
  return options
}

/**
 * Read messages from a file. Accepts a JSON array, an object with a
 * `messages` array, or one JSON object per line.
 */
export async function readMessages(path: string): Promise<Message[]> {
  const text = await readFile(resolve(path), 'utf8')
  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) return asMessages(parsed)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      if (Array.isArray(record.messages)) return asMessages(record.messages)
      if (typeof record.role === 'string') return [record as Message]
    }
    throw new Error('JSON file holds neither a message array nor a messages field')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('JSON file holds')) throw error
  }

  const messages: Message[] = []
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim()
    if (candidate.length === 0) continue
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object') messages.push(parsed as Message)
    } catch {
      throw new Error(`line is not valid JSON: ${truncateBytes(candidate, 60)}`)
    }
  }
  return messages
}

function asMessages(items: unknown[]): Message[] {
  return items.filter((item): item is Message => Boolean(item) && typeof item === 'object')
}

/** Pad or truncate a cell to a fixed width. */
function cell(text: string, width: number): string {
  const plain = truncateBytes(text.replace(/\s+/g, ' ').trim(), width)
  return plain.length >= width ? plain : plain + ' '.repeat(width - plain.length)
}

function printTable(rows: string[][], headers: string[]): void {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map(row => (row[column] ?? '').length)),
  )
  console.log(headers.map((header, i) => cell(header, widths[i])).join('  '))
  console.log(widths.map(width => '-'.repeat(width)).join('  '))
  for (const row of rows) {
    console.log(row.map((value, i) => cell(value, widths[i])).join('  '))
  }
}

/** Human-readable one-line stats footer. */
function statsLine(stats: CompactStats): string {
  return (
    `${stats.messages} messages, ${stats.kept} kept, ${stats.dropped} dropped, ` +
    `${formatBytes(stats.bytesBefore)} to ${formatBytes(stats.bytesAfter)}, ` +
    `${stats.jevCalls} Jev calls, $${stats.estimatedCost.toFixed(6)}` +
    (stats.fallback ? ', age-based fallback' : stats.degraded ? ', partially degraded' : '')
  )
}

async function commandScore(args: ParsedArgs): Promise<void> {
  const path = args.positional[0]
  if (!path) throw new Error('Usage: jev-compact score <file.jsonl>')
  const options = resolveOptions(optionsFromArgs(args))
  const messages = await readMessages(path)
  const segments = messages.map((message, index) => toSegment(message, index))
  const candidates = segments.filter(segment => !segment.empty)

  const outcome = await scoreSegments(candidates, options, segments.length)
  const ranked = [...candidates].sort((a, b) => a.index - b.index)

  const rows = ranked.map(segment => {
    const score = outcome.scores.get(segment.index)
    const flagged = segment.pin !== undefined ? 'pin' : score && score.confidence < options.minConfidence ? 'doubt' : ''
    return [
      segment.index.toString(),
      segment.role,
      score ? score.value.toFixed(3) : '-',
      score ? score.confidence.toFixed(3) : '-',
      score ? score.source : '-',
      flagged,
      segment.hash,
      truncateBytes(segment.text.replace(/\s+/g, ' ').trim(), 48),
    ]
  })

  printTable(rows, ['INDEX', 'ROLE', 'VALUE', 'CONF', 'SOURCE', 'FLAG', 'HASH', 'EXCERPT'])
  console.error(
    `\n${candidates.length} scored, ${segments.length - candidates.length} empty, ` +
      `${outcome.failedBatches} batches failed, ${outcome.calls} calls, ` +
      `$${estimateCost(outcome.stateBytes, options.pricePerMillionTokens).toFixed(6)} estimated`,
  )
  for (const error of outcome.errors) console.error(`  ${error}`)
}

async function commandCompact(args: ParsedArgs): Promise<void> {
  const path = args.positional[0]
  if (!path) throw new Error('Usage: jev-compact compact <file.jsonl> [--target-bytes N] [--scores receipts.jsonl]')
  const base: CompactOptions = {}
  const scoresPath = flagString(args, 'scores')
  if (scoresPath) {
    const entries = await readReceipts(scoresPath)
    base.scoreCache = loadScoreCache(entries)
    if (base.scoreCache.size === 0) {
      throw new Error(`no reusable scores found in ${scoresPath}`)
    }
  }
  const options = optionsFromArgs(args, base)
  const messages = await readMessages(path)
  const result = await compactMessages(messages, options.task, options)

  for (const message of result.messages) {
    console.log(JSON.stringify(message))
  }
  console.error(statsLine(result.stats))
}

async function commandReceipts(args: ParsedArgs): Promise<void> {
  const path = args.positional[0]
  if (!path) throw new Error('Usage: jev-compact receipts <path>')
  const entries = await readReceipts(path)
  const runs = groupRuns(entries)
  if (runs.length === 0) {
    console.log('No receipts found.')
    return
  }

  let totalKept = 0
  let totalDropped = 0
  for (const run of runs) {
    const decisions = run.decisions
    const kept = decisions.filter(d => d.kept)
    const dropped = decisions.filter(d => !d.kept)
    totalKept += kept.length
    totalDropped += dropped.length

    console.log(`${run.runId}  ${run.ts}`)
    if (run.task) console.log(`  task         ${truncateBytes(run.task, 90)}`)
    console.log(`  messages     ${decisions.length} kept ${kept.length} dropped ${dropped.length}`)
    if (run.stats) {
      console.log(`  bytes        ${formatBytes(run.stats.bytesBefore)} to ${formatBytes(run.stats.bytesAfter)}`)
      console.log(
        `  jev          ${run.stats.jevCalls} calls, ${run.stats.failedBatches} failed, ` +
          `fallback ${run.stats.fallback ? 'yes' : 'no'}, degraded ${run.stats.degraded ? 'yes' : 'no'}`,
      )
      console.log(`  cost         $${run.stats.estimatedCost.toFixed(6)}`)
      console.log(`  duration     ${run.stats.durationMs} ms`)
    }
    const topKept = [...kept].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 5)
    const topDropped = [...dropped].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 5)
    if (topKept.length > 0) {
      console.log(`  top kept     ${topKept.map(d => `[${d.index}] ${(d.value ?? 0).toFixed(2)} ${d.reason}`).join(', ')}`)
    }
    if (topDropped.length > 0) {
      console.log(`  top dropped  ${topDropped.map(d => `[${d.index}] ${(d.value ?? 0).toFixed(2)} ${d.reason}`).join(', ')}`)
    }
    console.log('')
  }
  console.log(`${runs.length} runs, ${totalKept} decisions kept, ${totalDropped} dropped`)
}

function printConfig(options: ResolvedOptions): void {
  console.log(`  endpoint      ${options.endpoint}`)
  console.log(`  api key       ${describeKey(options.apiKey)}`)
  console.log(`  receipt path  ${options.receiptPath || '(disabled)'}`)
  console.log(`  target bytes  ${options.targetBytes} (${formatBytes(options.targetBytes)})`)
  console.log(`  keep recent   ${options.keepRecent} messages`)
  console.log(`  batch size    ${options.batchSize} messages per request`)
  console.log(`  min conf      ${options.minConfidence}`)
  console.log(`  summary bytes ${options.summaryBytes}`)
  console.log(`  state bytes   ${options.stateMessageBytes} per message in the Jev state`)
  console.log(`  timeout       ${options.timeoutMs} ms`)
  console.log(`  levels        ${options.levels.join(', ')}`)
  console.log(`  pinning       ${options.enablePinning ? `on (${DEFAULT_PIN_PATTERNS.length} defaults + ${options.pinPatterns.length} custom, flags "${options.pinFlags}")` : 'off'}`)
  console.log(`  price         $${options.pricePerMillionTokens} per 1M input tokens`)
}

function describeKey(apiKey: string): string {
  if (!apiKey) return 'missing (JEV_API_KEY is not set)'
  const tail = apiKey.length > 4 ? apiKey.slice(-4) : apiKey
  return `set, ${apiKey.length} characters, ends ${tail}`
}

async function commandDoctor(args: ParsedArgs): Promise<void> {
  const options = resolveOptions(optionsFromArgs(args))
  console.log('Effective configuration')
  printConfig(options)

  console.log('\nEndpoint')
  const probe = await probeEndpoint(options.endpoint, Math.min(options.timeoutMs, 5000))
  console.log(`  reachable     ${probe.reachable ? 'yes' : 'no'} (${probe.detail})`)

  if (flagBool(args, 'probe')) {
    console.log('\nScore probe')
    if (!options.apiKey) {
      console.log('  skipped       JEV_API_KEY is not set')
    } else {
      try {
        const answers = await askJev(
          {
            endpoint: options.endpoint,
            apiKey: options.apiKey,
            timeoutMs: options.timeoutMs,
            levels: options.levels,
          },
          'Task: probe\n\n[0 | user]\nThe failing test is in src/parser.ts line 42.\n',
          ['How much does message [0] matter for completing the task?'],
        )
        const answer = answers[0]
        console.log(`  value         ${answer.value.toFixed(3)}`)
        console.log(`  confidence    ${answer.confidence.toFixed(3)}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log(`  failed        ${message}`)
      }
    }
  } else {
    console.log('  hint          add --probe to send one live score request')
  }

  const failing: string[] = []
  if (!options.apiKey) failing.push('JEV_API_KEY is not set, compaction will run age-based')
  if (!probe.reachable) failing.push('endpoint did not answer, compaction will run age-based')
  if (failing.length > 0) {
    console.log('\nFindings')
    for (const finding of failing) console.log(`  ${finding}`)
  } else {
    console.log('\nFindings\n  configuration is usable')
  }
}

const USAGE = `Usage: jev-compact <command> [args]

Commands:
  score <file.jsonl>     Score messages and print a value table
  compact <file.jsonl>   Compact a conversation, JSONL on stdout
  receipts <path>        Summarise a decision receipts file
  doctor                 Check endpoint, key and effective config

Options for score and compact:
  --target-bytes N       Output byte budget (default 262144)
  --keep-recent N        Trailing messages kept verbatim (default 4)
  --batch-size N         Messages per Jev request (default 8)
  --min-confidence X     Below this, a message is kept (default 0.35)
  --summary-bytes N      Digest byte cap (default 1024)
  --state-message-bytes N  Bytes per message in the Jev state (default 2000)
  --timeout MS           Per-request timeout (default 15000)
  --price X              USD per 1M input tokens for the estimate (default 0.1)
  --task TEXT            Task line sent to Jev
  --endpoint URL         Override JEV_API_URL
  --pin PATTERN          Extra pin pattern, repeatable
  --no-pin               Disable pinning
  --receipt PATH         Write a JSONL decision receipt
  --scores PATH          Reuse recorded scores from a receipts file
  --levels a,b,c         Override the score labels

Doctor options:
  --probe                Send one live score request`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const command = args.positional[0]

  switch (command) {
    case 'score':
      await commandScore({ positional: args.positional.slice(1), flags: args.flags })
      break
    case 'compact':
      await commandCompact({ positional: args.positional.slice(1), flags: args.flags })
      break
    case 'receipts':
      await commandReceipts({ positional: args.positional.slice(1), flags: args.flags })
      break
    case 'doctor':
      await commandDoctor({ positional: args.positional.slice(1), flags: args.flags })
      break
    default:
      console.log(USAGE)
  }
}

main().catch(error => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
