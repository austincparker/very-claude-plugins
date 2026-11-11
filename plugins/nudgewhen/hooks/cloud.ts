import type { McpToolResult } from 'claude-code'

import { MINUTE } from './schedule'

export type HostedNudge = { id: string; source: string; text: string; due: number }
export type Seen = { id: string; at: number }

export const POLL_MS = MINUTE
export const BACKOFF_MAX_MS = 15 * MINUTE
export const SEEN_MS = 60 * MINUTE
export const ACK_BATCH = 100

/** Delay before the next attempt: 60 s after a success, then doubling from 60 s per consecutive failure, capped at 15 minutes. */
export function delayAfter(failures: number): number {
  if (failures <= 0) return POLL_MS
  return Math.min(POLL_MS * 2 ** Math.min(failures - 1, 10), BACKOFF_MAX_MS)
}

/** The nudges in a `poll_nudges` result, malformed entries dropped; null when the result is an error or is not the expected JSON. */
export function parsePoll(result: McpToolResult): HostedNudge[] | null {
  if (result.isError) return null
  const block = result.content.find(b => b.type === 'text')
  if (!block || typeof block.text !== 'string') return null
  let body: unknown
  try {
    body = JSON.parse(block.text)
  } catch {
    return null
  }
  const list = body !== null && typeof body === 'object' ? (body as { nudges?: unknown }).nudges : undefined
  if (!Array.isArray(list)) return null
  return list.filter(
    (n): n is HostedNudge =>
      n !== null &&
      typeof n === 'object' &&
      typeof n.id === 'string' &&
      n.id !== '' &&
      typeof n.source === 'string' &&
      typeof n.text === 'string' &&
      typeof n.due === 'number',
  )
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
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
