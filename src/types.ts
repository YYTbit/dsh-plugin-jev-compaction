/**
 * Shared types for the Jev compaction plugin.
 * @module dsh-plugin-jev-compaction/types
 */

/**
 * A chat message as it travels through the harness.
 * Unknown fields are carried through untouched so a message that survives
 * compaction is byte-identical to the one that entered it.
 */
export interface Message {
  role?: string
  content?: unknown
  [key: string]: unknown
}

/** A message reduced to the fields the compactor reasons about. */
export interface Segment {
  /** Position in the original message list. */
  index: number
  /** Message role, defaulting to `user` when absent. */
  role: string
  /** Text extracted from `content`, used for hashing, pinning and scoring. */
  text: string
  /** UTF-8 size of `text`. This is the number the byte budget is spent on. */
  bytes: number
  /** First 16 hex characters of the SHA-256 of `text`. */
  hash: string
  /** The original message, preserved for round-tripping. */
  message: Message
  /** True when the message carries no text at all. */
  empty: boolean
  /** Source of a matching pin pattern, when one matched. */
  pin?: string
}

/** Where a message value came from. */
export type ScoreSource = 'jev' | 'age' | 'cache' | 'policy'

/** A single message value. */
export interface ValueScore {
  value: number
  confidence: number
  source: ScoreSource
}

/** Per-message record of what compaction decided and why. */
export interface Decision {
  index: number
  role: string
  hash: string
  bytes: number
  /** Value in [0, 1], or null when the message was never scored. */
  value: number | null
  /** Confidence in [0, 1], or null when the message was never scored. */
  confidence: number | null
  source: ScoreSource | 'pin'
  kept: boolean
  reason: string
}

/** Counters describing one compaction run. */
export interface CompactStats {
  /** Messages considered. */
  messages: number
  kept: number
  dropped: number
  bytesBefore: number
  bytesAfter: number
  targetBytes: number
  /** Bytes above target, non-zero when the protected set alone exceeds the budget. */
  overBudgetBytes: number
  /** Jev requests actually sent. */
  jevCalls: number
  /** Bytes of state sent to Jev. */
  jevStateBytes: number
  /** Batches that failed and were scored by recency instead. */
  failedBatches: number
  /** Estimated input cost in USD, from `pricePerMillionTokens`. */
  estimatedCost: number
  /** True when every scored batch failed and the run is pure age-based. */
  fallback: boolean
  /** True when at least one batch failed but others succeeded. */
  degraded: boolean
  durationMs: number
  /** Identifier for this run, also written into receipts. */
  runId: string
  /** True when a decision receipt was written. */
  receiptWritten: boolean
}

/** Result of a compaction run. */
export interface CompactResult {
  messages: Message[]
  decisions: Decision[]
  stats: CompactStats
}

/**
 * Everything the compactor and the plugin can be configured with.
 * Fields left undefined fall back to the environment and then to the defaults
 * listed on each field.
 */
export interface CompactOptions {
  /** Output byte budget. Default: 262144 (256 KiB). */
  targetBytes?: number
  /** Trailing messages kept verbatim regardless of score. Default: 4. */
  keepRecent?: number
  /** Messages scored per Jev request. Default: 8. */
  batchSize?: number
  /** Extra pin patterns, appended to the built-in defaults. */
  pinPatterns?: string[]
  /** Set false to disable pinning entirely. Default: true. */
  enablePinning?: boolean
  /** Flags used when compiling pin patterns. Default: 'i'. */
  pinFlags?: string
  /** Scores below this confidence are treated as high value. Default: 0.35. */
  minConfidence?: number
  /** Byte cap on the digest that replaces dropped messages. Default: 1024. */
  summaryBytes?: number
  /** Role used for the digest message. Default: 'system'. */
  summaryRole?: string
  /** Bytes of each message included in the Jev state block. Default: 2000. */
  stateMessageBytes?: number
  /** Jev endpoint. Default: JEV_API_URL or https://api.typesafe.ai/v1/systemone. */
  endpoint?: string
  /** Jev API key. Default: JEV_API_KEY. */
  apiKey?: string
  /** Per-request timeout in milliseconds. Default: 15000. */
  timeoutMs?: number
  /** Ordered score labels sent as `levels`. Default: none, low, medium, high, critical. */
  levels?: string[]
  /** Input price used for the cost estimate, USD per million tokens. Default: 0.10. */
  pricePerMillionTokens?: number
  /** JSONL decision receipt path. Disabled by default. */
  receiptPath?: string
  /** Task description passed to Jev. Default: a generic continuation prompt. */
  task?: string
  /** Run identifier written into receipts. Generated when omitted. */
  runId?: string
  /** Pre-recorded scores keyed by content hash, used instead of calling Jev. */
  scoreCache?: Map<string, ValueScore>
}

/** Options with every default applied. */
export interface ResolvedOptions {
  targetBytes: number
  keepRecent: number
  batchSize: number
  pinPatterns: string[]
  enablePinning: boolean
  pinFlags: string
  minConfidence: number
  summaryBytes: number
  summaryRole: string
  stateMessageBytes: number
  endpoint: string
  apiKey: string
  timeoutMs: number
  levels: string[]
  pricePerMillionTokens: number
  receiptPath: string
  task: string
  runId: string
  scoreCache?: Map<string, ValueScore>
}
