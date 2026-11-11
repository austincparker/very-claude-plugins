import { fmtHHMM, minuteOfDay } from './controls'
import { ciText, hostedText, reviewsText } from './hosted'
import type { HostedStatus } from './hosted'
import { MINUTE, clock, dayHint, hourLabel, isBedtime, span } from './schedule'
import type { Nudge } from './schedule'
import { localStamp } from './sitting'
import type { LogRow } from './sitting'

export const SEPARATOR = '  ·  '
export const DEFAULT_SEGMENTS = 'sit,bed,hosted'

export const FREE = ['sit', 'break', 'next', 'bed', 'breaks', 'context', 'limits', 'cost', 'model', 'branch'] as const
export const PAID = ['hosted', 'ci', 'reviews'] as const
export type Free = (typeof FREE)[number]
export type Paid = (typeof PAID)[number]

const NEXT_TEXT_MAX = 24
const BED_LEAD_MIN = 120

function isKnown(name: string): name is Free | Paid {
  return (FREE as readonly string[]).includes(name) || (PAID as readonly string[]).includes(name)
}

function tokens(list: string): string[] {
  return list.split(',').map(t => t.trim().toLowerCase()).filter(t => t !== '')
}

/** The known segment names in `list`, in order, each once. */
export function parseSegments(list: string): (Free | Paid)[] {
  return [...new Set(tokens(list))].filter(isKnown)
}

/** The names in `list` that are not segments. */
export function unknownSegments(list: string): string[] {
  return [...new Set(tokens(list))].filter(t => !isKnown(t))
}

let hosted: HostedStatus | undefined

/** Keeps the latest `hosted_status` reading for the paid segments; `undefined` clears it. */
export function setHosted(status: HostedStatus | undefined): void {
  hosted = status
}

/** The text of a paid segment: empty until a hosted status has arrived. */
export function paidText(name: Paid): string {
  switch (name) {
    case 'hosted':
      return hostedText(hosted)
    case 'ci':
      return ciText(hosted)
    case 'reviews':
      return reviewsText(hosted)
  }
}

export function isPaid(name: string): name is Paid {
  return (PAID as readonly string[]).includes(name)
}

export function contextText(percent: number | undefined): string {
  return percent === undefined ? '' : `ctx ${percent}%`
}

const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

/** The rate-limit window closest to its cap. */
export function limitsText(limits: readonly { kind: string; percentUsed: number }[]): string {
  let top: { kind: string; percentUsed: number } | undefined
  for (const l of limits) if (top === undefined || l.percentUsed > top.percentUsed) top = l
  return top === undefined ? '' : `${LIMIT_NAMES[top.kind] ?? top.kind} ${top.percentUsed}%`
}

export function costText(usd: number | undefined): string {
  return usd === undefined ? '' : `$${usd.toFixed(2)}`
}

/** `11pm` on the hour, `22:30` otherwise. */
export function timeLabel(minute: number): string {
  return minute % 60 === 0 ? hourLabel(minute / 60) : fmtHHMM(minute)
}

/** The wrap-up text past bedtime, a countdown in the last two hours before it, else nothing. */
export function bedText(now: number, bedMin: number, wakeMin: number): string {
  const minute = minuteOfDay(now)
  if (isBedtime(minute, bedMin, wakeMin)) return `past ${timeLabel(bedMin)} · time to wrap up`
  const left = (bedMin - minute + 1440) % 1440
  return left > 0 && left <= BED_LEAD_MIN ? `bed in ${span(left * MINUTE)}` : ''
}

/** How long you have sat, once it passes the limit; louder at twice the limit. */
export function sitText(sat: number | null, sitMin: number): string {
  if (sat === null || sat < sitMin) return ''
  return sat >= 2 * sitMin ? `sat ${sat}m · stand up` : `sat ${sat}m`
}

/** The time left before the break nudge. */
export function breakText(sat: number | null, sitMin: number): string {
  return sat === null || sat >= sitMin ? '' : `break in ${sitMin - sat}m`
}

/** The soonest reminder. */
export function nextText(nudges: readonly Nudge[], now: number): string {
  const first = [...nudges].sort((a, b) => a.due - b.due)[0]
  if (first === undefined) return ''
  const text = first.text.length > NEXT_TEXT_MAX ? `${first.text.slice(0, NEXT_TEXT_MAX - 1)}…` : first.text
  return `next ${clock(first.due)}${dayHint(first.due, now)} ${text}`
}

/** Breaks logged today. */
export function breaksText(rows: readonly LogRow[], now: number): string {
  const today = localStamp(now).slice(0, 10)
  return `breaks ${rows.filter(r => r[1] === 'break' && r[0].startsWith(today)).length}`
}

export function joinSegments(parts: readonly string[]): string {
  return parts.filter(p => p !== '').join(SEPARATOR)
}
