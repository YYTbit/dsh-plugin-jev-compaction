/**
 * Client for the TypeSafe System One (Jev) endpoint.
 *
 * One request carries one state and one or more typed questions about it.
 * System One answers with a probability distribution over the supplied levels
 * in a single forward pass and emits no output tokens, so the cost of a
 * request is its input size alone.
 *
 * The response reducer is deliberately tolerant. Endpoints in this family
 * return either `probabilities` over `levels`, a single chosen `level`, or a
 * numeric `score`, and callers should not care which. Anything that cannot be
 * reduced to a value in [0, 1] plus a confidence raises `JevError` with code
 * `malformed`, which the caller treats exactly like a network failure.
 *
 * @module dsh-plugin-jev-compaction/jev
 */

import { clamp01 } from './text.js'

/** Default endpoint used when neither config nor `JEV_API_URL` is set. */
export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** Default ordered score labels. */
export const DEFAULT_LEVELS = ['none', 'low', 'medium', 'high', 'critical']

/** Failure classes the caller distinguishes only for logging. */
export type JevErrorCode = 'missing-key' | 'network' | 'timeout' | 'http' | 'malformed'

/** Any failure that should send the caller to the age-based fallback. */
export class JevError extends Error {
  readonly code: JevErrorCode
  readonly status?: number

  constructor(code: JevErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'JevError'
    this.code = code
    this.status = status
  }
}

/** Everything needed to talk to the endpoint. */
export interface JevClientOptions {
  endpoint: string
  apiKey: string
  timeoutMs: number
  levels: string[]
}

/** A reduced answer. Both fields are in [0, 1]. */
export interface JevAnswer {
  value: number
  confidence: number
}

/** Read a candidate array of answers out of an unknown payload. */
function pickArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of ['results', 'answers', 'answer', 'data', 'scores', 'questions', 'outputs']) {
      const candidate = record[key]
      if (Array.isArray(candidate)) return candidate
    }
  }
  return null
}

/** Reduce an unknown answer object to a value plus a confidence. */
function reduceAnswer(answer: unknown, levels: string[], values: number[]): JevAnswer | null {
  if (typeof answer === 'number' && Number.isFinite(answer)) {
    return { value: clamp01(answer), confidence: 1 }
  }
  if (!answer || typeof answer !== 'object') return null
  const record = answer as Record<string, unknown>

  // A distribution over ordered levels reduces to its expected rank. Weights
  // are renormalised so an unnormalised payload still yields a valid answer.
  const rawWeights = record.probabilities ?? record.probs ?? record.distribution ?? record.weights
  if (Array.isArray(rawWeights) && rawWeights.length > 0) {
    const weights = rawWeights.map(w => (typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 0))
    const total = weights.reduce((a, b) => a + b, 0)
    if (total <= 0) return null
    const ranks = values.length === weights.length ? values : spread(weights.length)
    let expected = 0
    let peak = 0
    for (let i = 0; i < weights.length; i += 1) {
      expected += (weights[i] / total) * ranks[i]
      peak = Math.max(peak, weights[i] / total)
    }
    return { value: clamp01(expected), confidence: clamp01(peak) }
  }

  // A single chosen level, either as a label or as an index.
  const level = record.level ?? record.label ?? record.choice
  const confidence = firstNumber(record.confidence, record.probability, record.prob, record.p)
  if (typeof level === 'string') {
    const index = labelIndex(level, record, levels)
    if (index >= 0) {
      return { value: clamp01(values[index]), confidence: clamp01(confidence ?? 1) }
    }
  }
  if (typeof level === 'number' && Number.isFinite(level)) {
    if (Number.isInteger(level) && level >= 0 && level < values.length) {
      return { value: clamp01(values[level]), confidence: clamp01(confidence ?? 1) }
    }
    if (level >= 0 && level <= 1) return { value: clamp01(level), confidence: clamp01(confidence ?? 1) }
  }

  // A direct score.
  const score = firstNumber(record.value, record.score, record.answer, record.result)
  if (score !== undefined) return { value: clamp01(score), confidence: clamp01(confidence ?? 1) }

  return null
}

/** Evenly spaced values in [0, 1], used when a payload does not echo levels. */
function spread(count: number): number[] {
  if (count <= 1) return [1]
  const values: number[] = []
  for (let i = 0; i < count; i += 1) values.push(i / (count - 1))
  return values
}

/** First finite number among the candidates. */
function firstNumber(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return undefined
}

/** Index of a level label, consulting an echoed label list when present. */
function labelIndex(label: string, record: Record<string, unknown>, levels: string[]): number {
  const needle = label.trim().toLowerCase()
  const echoed = record.levels ?? record.labels
  const list = Array.isArray(echoed) && echoed.length > 0 ? echoed.map(String) : levels
  let index = list.findIndex(item => item.trim().toLowerCase() === needle)
  if (index >= 0) return index
  // A payload may echo the same scale under a different spelling, so fall back
  // to a prefix match before giving up.
  index = list.findIndex(item => item.trim().toLowerCase().startsWith(needle))
  return index
}

/** Turn a configured label list into numeric ranks. */
export function levelValues(levels: string[]): number[] {
  return spread(levels.length)
}

/**
 * Ask Jev one or more questions about a single state.
 *
 * A single question is sent as a string and a batch as an array, which is the
 * shape the typed request expects. Answers come back in question order.
 * Throws `JevError` on any failure.
 */
export async function askJev(
  client: JevClientOptions,
  state: string,
  questions: string[],
): Promise<JevAnswer[]> {
  if (!client.apiKey) {
    throw new JevError('missing-key', 'JEV_API_KEY is not set')
  }
  if (questions.length === 0) return []

  const body = {
    state,
    question: questions.length === 1 ? questions[0] : questions,
    type: 'score',
    levels: client.levels,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), client.timeoutMs)

  let response: Response
  try {
    response = await fetch(client.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${client.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) {
      throw new JevError('timeout', `Jev request exceeded ${client.timeoutMs} ms`)
    }
    throw new JevError('network', `Jev request failed: ${message}`)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new JevError('http', `Jev returned HTTP ${response.status}`, response.status)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new JevError('malformed', 'Jev response was not valid JSON')
  }

  const values = levelValues(client.levels)
  const candidates = pickArray(payload)

  if (candidates) {
    const answers: JevAnswer[] = []
    for (let i = 0; i < questions.length; i += 1) {
      const reduced = reduceAnswer(candidates[i], client.levels, values)
      if (!reduced) {
        throw new JevError('malformed', `Jev answer ${i} could not be reduced to a score`)
      }
      answers.push(reduced)
    }
    return answers
  }

  if (questions.length === 1) {
    const reduced = reduceAnswer(payload, client.levels, values)
    if (!reduced) throw new JevError('malformed', 'Jev response contained no score')
    return [reduced]
  }

  throw new JevError('malformed', `Jev returned ${questions.length} questions but no answer array`)
}

/**
 * Reachability probe for `doctor`. Any HTTP status counts as reachable, since
 * a 401 or 405 still proves the host answered.
 */
export async function probeEndpoint(
  endpoint: string,
  timeoutMs = 5000,
): Promise<{ reachable: boolean; status?: number; detail: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint, { method: 'HEAD', signal: controller.signal })
    return { reachable: true, status: response.status, detail: `HTTP ${response.status}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) return { reachable: false, detail: `timeout after ${timeoutMs} ms` }
    return { reachable: false, detail: message }
  } finally {
    clearTimeout(timer)
  }
}

/** Estimate input tokens from a byte count. Four bytes per token is the usual ratio. */
export function estimateTokens(bytes: number): number {
  return bytes / 4
}

/** Estimated USD cost for a run that sent `bytes` of state. */
export function estimateCost(bytes: number, pricePerMillionTokens: number): number {
  return (estimateTokens(bytes) / 1_000_000) * pricePerMillionTokens
}
