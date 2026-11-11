/** Pure parsing and rules for the time and quiet settings; nothing here touches the engine. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A span of the day in minutes since midnight; `start` after `end` wraps past midnight. */
export type Range = { start: number; end: number }

export type Controls = {
  bedMin: number
  wakeMin: number
  work: Range | null
  workDays: number[] | null
  quiet: Range | null
}

export type Warning = { key: string; fallback: string; text: string }

/** What `/nudge snooze` and `/nudge pause` keep: `until` null holds until `/nudge resume`. */
export type Hold = { until: number | null }

export const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export const WEEKDAYS = [1, 2, 3, 4, 5]

export const DEFAULTS = { bedtime: '23:00', wake: '05:00', work_hours: '', work_days: '', quiet_hours: '' } as const

/** Minutes since midnight for `H:MM` or `HH:MM`, else null. */
export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h > 23 || min > 59 ? null : h * 60 + min
}

export function fmtHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** `HH:MM-HH:MM`; the two ends must differ. */
export function parseRange(s: string): Range | null {
  const m = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(s)
  if (!m) return null
  const start = parseHHMM(m[1] ?? '')
  const end = parseHHMM(m[2] ?? '')
  return start === null || end === null || start === end ? null : { start, end }
}

export function fmtRange(r: Range): string {
  return `${fmtHHMM(r.start)}-${fmtHHMM(r.end)}`
}

export function inRange(r: Range, minute: number): boolean {
  return r.start < r.end ? minute >= r.start && minute < r.end : minute >= r.start || minute < r.end
}

/** A comma list of mon to sun as sorted day numbers (sunday 0), else null. */
export function parseDays(s: string): number[] | null {
  const days = new Set<number>()
  for (const part of s.split(',')) {
    const i = DAY_NAMES.indexOf(part.trim().toLowerCase() as (typeof DAY_NAMES)[number])
    if (i < 0) return null
    days.add(i)
  }
  return [...days].sort((a, b) => a - b)
}

/** Day numbers as a comma list in week order, monday first. */
export function fmtDays(days: readonly number[]): string {
  return [1, 2, 3, 4, 5, 6, 0].filter(d => days.includes(d)).map(d => DAY_NAMES[d]).join(',')
}

/** `30m`, `2h`, `1h30m` in milliseconds, else null. */
export function parseDuration(s: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/i.exec(s.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  const ms = Number(m[1] ?? 0) * HOUR + Number(m[2] ?? 0) * MINUTE
  return ms > 0 ? ms : null
}

export function minuteOfDay(now: number): number {
  const d = new Date(now)
  return d.getHours() * 60 + d.getMinutes()
}

/** Each setting read from `options`; one that does not parse takes its default and adds a warning. */
export function readControls(options: Readonly<Record<string, unknown>>): { controls: Controls; warnings: Warning[] } {
  const warnings: Warning[] = []
  const read = <T>(key: keyof typeof DEFAULTS, parse: (s: string) => T | null): T | null => {
    const raw = options[key]
    const text = typeof raw === 'string' ? raw.trim() : ''
    const fallback = DEFAULTS[key]
    if (text === '') return fallback === '' ? null : parse(fallback)
    const value = parse(text)
    if (value !== null) return value
    const used = fallback === '' ? 'no limit' : fallback
    warnings.push({ key, fallback, text: `nudgewhen: ${key} "${text}" is not valid; using the default (${used}).` })
    return fallback === '' ? null : parse(fallback)
  }
  return {
    controls: {
      bedMin: read('bedtime', parseHHMM) ?? 23 * 60,
      wakeMin: read('wake', parseHHMM) ?? 5 * 60,
      work: read('work_hours', parseRange),
      workDays: read('work_days', parseDays),
      quiet: read('quiet_hours', parseRange),
    },
    warnings,
  }
}

/** Whether break nudges apply at `now`: inside the work days and the work hours, each empty meaning always. The after-midnight part of a wrapping shift counts toward the day it began on. */
export function isWorkTime(c: Controls, now: number): boolean {
  const minute = minuteOfDay(now)
  if (c.work !== null && !inRange(c.work, minute)) return false
  if (c.workDays === null) return true
  const isTail = c.work !== null && c.work.start > c.work.end && minute < c.work.end
  const day = new Date(now).getDay()
  return c.workDays.includes(isTail ? (day + 6) % 7 : day)
}

export function isQuiet(c: Controls, now: number): boolean {
  return c.quiet !== null && inRange(c.quiet, minuteOfDay(now))
}

/** The stored hold, or undefined when the value is not one. */
export function readHold(v: unknown): Hold | undefined {
  if (v === null || typeof v !== 'object' || !('until' in v)) return undefined
  const { until } = v as { until: unknown }
  if (until === null) return { until: null }
  return typeof until === 'number' && Number.isFinite(until) ? { until } : undefined
}

export function isHeld(h: Hold | undefined, now: number): boolean {
  return h !== undefined && (h.until === null || h.until > now)
}

/** The next local time at `minute` of the day strictly after `now`. */
function nextMinute(minute: number, now: number): number {
  const d = new Date(now)
  d.setHours(Math.floor(minute / 60), minute % 60, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** The local time at `minute` of the day after the one `now` falls on. */
function tomorrowAt(minute: number, now: number): number {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(Math.floor(minute / 60), minute % 60, 0, 0)
  return d.getTime()
}

/** The hold a `/nudge pause` argument asks for: nothing is until resume, `until HH:MM`, or `tomorrow` (the wake time on the next day); null when it is none of these. */
export function parsePause(arg: string, now: number, wakeMin: number): Hold | null {
  const a = arg.trim()
  if (a === '') return { until: null }
  if (/^tomorrow$/i.test(a)) return { until: tomorrowAt(wakeMin, now) }
  const m = /^until\s+(\S+)$/i.exec(a)
  const minute = m ? parseHHMM(m[1] ?? '') : null
  return minute === null ? null : { until: nextMinute(minute, now) }
}
