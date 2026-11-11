import type { McpToolResult } from 'claude-code'

import { clean } from './cloud'
import { MINUTE } from './schedule'

export const STATUS_MS = 5 * MINUTE
export const KINDS = ['ci', 'review_requested', 'review_submitted', 'pr_landed'] as const
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
export const REPO_MAX = 140
export const MUTED_MAX = 100
/** The latest time a `Date` holds: a pause with no end. */
export const PAUSE_FOREVER = 8.64e15
export const SIGN_IN_HINT = 'Hosted nudges are not connected: sign in with /mcp, then try again.'
const SEGMENT_MAX = 60

export type Stamped = { text: string; at: number }
export type HostedStatus = {
  pending: number
  next_due: number | null
  paused_until: number | null
  quiet_now: boolean
  kinds: string[]
  muted_repos: number
  last_ci: Stamped | null
  last_review: Stamped | null
}
export type HostedPrefs = {
  kinds: string[]
  muted_repos: string[]
  failures_only: boolean
  quiet: string
  tz: string
  paused_until: number | null
}

function body(result: McpToolResult): Record<string, unknown> | null {
  if (result.isError || !Array.isArray(result.content)) return null
  const block = result.content.find(b => b !== null && typeof b === 'object' && b.type === 'text')
  if (!block || typeof block.text !== 'string') return null
  try {
    const v: unknown = JSON.parse(block.text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const KINDS_MAX = 20

/** A server list kept to the lengths the controls themselves allow. */
const capped = (v: string[], count: number, length: number): string[] => v.filter(x => x.length <= length).slice(0, count)

function stamped(v: unknown): Stamped | null | undefined {
  if (v === null) return null
  if (v === undefined || typeof v !== 'object') return undefined
  const s = v as Record<string, unknown>
  return typeof s.text === 'string' && isNum(s.at) ? { text: s.text, at: s.at } : undefined
}

/** A `hosted_status` result, or null when it is an error or not the shape. */
export function parseHostedStatus(result: McpToolResult): HostedStatus | null {
  const b = body(result)
  if (b === null) return null
  const ci = b.last_ci === undefined ? null : stamped(b.last_ci)
  const review = b.last_review === undefined ? null : stamped(b.last_review)
  if (
    !isNum(b.pending) ||
    !isNumOrNull(b.next_due) ||
    !isNumOrNull(b.paused_until) ||
    typeof b.quiet_now !== 'boolean' ||
    !isStrings(b.kinds) ||
    !isNum(b.muted_repos) ||
    ci === undefined ||
    review === undefined
  ) {
    return null
  }
  return {
    pending: b.pending,
    next_due: b.next_due,
    paused_until: b.paused_until,
    quiet_now: b.quiet_now,
    kinds: capped(b.kinds, KINDS_MAX, REPO_MAX),
    muted_repos: b.muted_repos,
    last_ci: ci,
    last_review: review,
  }
}

/** A `get_prefs` or `set_prefs` result, or null when it is an error or not the shape. */
export function parsePrefs(result: McpToolResult): HostedPrefs | null {
  const b = body(result)
  if (
    b === null ||
    !isStrings(b.kinds) ||
    !isStrings(b.muted_repos) ||
    typeof b.failures_only !== 'boolean' ||
    typeof b.quiet !== 'string' ||
    typeof b.tz !== 'string' ||
    !isNumOrNull(b.paused_until)
  ) {
    return null
  }
  return {
    kinds: capped(b.kinds, KINDS_MAX, REPO_MAX),
    muted_repos: capped(b.muted_repos, MUTED_MAX, REPO_MAX),
    failures_only: b.failures_only,
    quiet: b.quiet,
    tz: b.tz,
    paused_until: b.paused_until,
  }
}

/** What the `hosted` segment shows at `now`: paused, then quiet, then the pending count, else ok. */
export function hostedText(s: HostedStatus | undefined, now: number): string {
  if (s === undefined) return ''
  if (s.paused_until !== null && s.paused_until > now) return 'hosted paused'
  if (s.quiet_now) return 'hosted quiet'
  return s.pending > 0 ? `hosted ${s.pending} pending` : 'hosted ok'
}

export const ciText = (s: HostedStatus | undefined): string => (s?.last_ci ? clean(s.last_ci.text, SEGMENT_MAX) : '')
export const reviewsText = (s: HostedStatus | undefined): string => (s?.last_review ? clean(s.last_review.text, SEGMENT_MAX) : '')

/** The local IANA zone, sent with quiet hours and pauses so the server reads them as the person does. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** `prefs` as lines for `/nudge prefs`; the server's words are cleaned and cut before they reach the terminal. */
export function prefsLines(p: HostedPrefs, now: number): string[] {
  const list = (items: string[]) => items.map(x => clean(x, REPO_MAX)).join(', ') || 'none'
  const paused = p.paused_until !== null && p.paused_until > now ? 'yes' : 'no'
  return [
    'Hosted preferences:',
    `  kinds: ${list(p.kinds)}`,
    `  muted repos: ${list(p.muted_repos)}`,
    `  failures only: ${p.failures_only ? 'on' : 'off'}`,
    `  quiet hours: ${p.quiet === '' ? 'none' : `${clean(p.quiet, 20)} (${clean(p.tz, 40)})`}`,
    `  paused: ${paused}`,
  ]
}
