import type { McpToolResult } from 'claude-code'

import { MINUTE } from './schedule'

export type HostedNudge = { id: string; source: string; text: string; due: number }
export type Seen = { id: string; at: number }

export const POLL_MS = MINUTE
export const BACKOFF_MAX_MS = 15 * MINUTE
export const SEEN_MS = 60 * MINUTE
export const ACK_BATCH = 100
export const CALL_TIMEOUT_MS = 30_000
export const HOSTED_MAX = 100
export const PENDING_MAX = 1000
const ID_MAX = 200
const SOURCE_MAX = 40
const TEXT_MAX = 300

/** `s` with control, bidi and zero-width characters (ESC, newlines, C1) made spaces and its length capped, safe to print in the terminal UI. */
export function clean(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Delay before the next attempt: 60 s after a success, then doubling from 60 s per consecutive failure, capped at 15 minutes. */
export function delayAfter(failures: number): number {
  if (failures <= 0) return POLL_MS
  return Math.min(POLL_MS * 2 ** Math.min(failures - 1, 10), BACKOFF_MAX_MS)
}

function hasNudges(v: unknown): v is { nudges: unknown } {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && 'nudges' in v
}

/** The first `HOSTED_MAX` nudges in a `poll_nudges` result, malformed entries dropped; null when the result is an error or is not the expected JSON. */
export function parsePoll(result: McpToolResult): HostedNudge[] | null {
  if (result.isError) return null
  if (!Array.isArray(result.content)) return null
  const block = result.content.find(b => b !== null && typeof b === 'object' && b.type === 'text')
  if (!block || typeof block.text !== 'string') return null
  let body: unknown
  try {
    body = JSON.parse(block.text)
  } catch {
    return null
  }
  const list = hasNudges(body) ? body.nudges : undefined
  if (!Array.isArray(list)) return null
  return list
    .filter(
      (n): n is HostedNudge =>
        n !== null &&
        typeof n === 'object' &&
        typeof n.id === 'string' &&
        n.id !== '' &&
        n.id.length <= ID_MAX &&
        typeof n.source === 'string' &&
        typeof n.text === 'string' &&
        typeof n.due === 'number',
    )
    .slice(0, HOSTED_MAX)
    .map(n => ({ ...n, source: clean(n.source, SOURCE_MAX), text: clean(n.text, TEXT_MAX) }))
}

/** Splits `ids` into acks of at most 100. */
export function batches(ids: string[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += ACK_BATCH) out.push(ids.slice(i, i + ACK_BATCH))
  return out
}

/** The `seen` entries still inside the hour, read defensively from the store. */
export function readSeen(v: unknown, now: number): Seen[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (s): s is Seen =>
      s !== null && typeof s === 'object' && typeof s.id === 'string' && typeof s.at === 'number' && now - s.at < SEEN_MS,
  )
}

export function readIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-PENDING_MAX) : []
}
