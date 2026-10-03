/**
 * Text helpers shared by scoring, pinning and receipts.
 *
 * Every size in this plugin is a UTF-8 byte count, never a character count,
 * because the budget the harness cares about is the byte length of the
 * serialised conversation.
 *
 * @module dsh-plugin-jev-compaction/text
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Message } from './types.js'

/** UTF-8 byte length of a string. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Expand a leading `~` to the home directory.
 * Configuration is written by hand, and a path written that way would
 * otherwise be created as a directory literally named `~`.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** First 16 hex characters of the SHA-256 of a string. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Truncate to at most `max` UTF-8 bytes without splitting a codepoint.
 * Walks codepoints because slicing a Buffer can leave a broken character.
 */
export function truncateBytes(text: string, max: number): string {
  if (max <= 0) return ''
  if (byteLength(text) <= max) return text
  let used = 0
  let out = ''
  for (const ch of text) {
    const size = byteLength(ch)
    if (used + size > max) break
    out += ch
    used += size
  }
  return out
}

/** Collapse all whitespace runs so a string renders on one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Clamp a number into [0, 1], mapping NaN to 0. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

/**
 * Extract the scoreable text from a message.
 *
 * Handles the plain-string form, the content-parts form used by most
 * providers, and the tool-call form where `content` is empty and the payload
 * lives in `tool_calls`.
 */
export function messageText(message: Message): string {
  const content = message.content

  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part)
        continue
      }
      if (part && typeof part === 'object') {
        const record = part as Record<string, unknown>
        const text = record.text ?? record.content ?? record.output
        if (typeof text === 'string') parts.push(text)
      }
    }
    if (parts.length > 0) return parts.join('\n')
  } else if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content)
    } catch {
      return ''
    }
  }

  const extra: string[] = []
  if (message.tool_calls !== undefined) {
    try {
      extra.push(JSON.stringify(message.tool_calls))
    } catch {
      /* circular or non-serialisable tool calls carry no scoreable text */
    }
  }
  if (typeof message.content_text === 'string') extra.push(message.content_text)
  return extra.join('\n')
}

/** Message role, defaulting to `user` for objects without one. */
export function messageRole(message: Message): string {
  return typeof message.role === 'string' && message.role.length > 0 ? message.role : 'user'
}
