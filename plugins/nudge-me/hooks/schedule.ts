export const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type Nudge = {
  id: number
  text: string
  due: number
  everyMs?: number
  /** `HH:MM`, local time: the nudge comes back every day at this time. */
  daily?: string
}

export type When = { due: number; everyMs?: number; daily?: string; text: string }

export const USAGE = [
  'Usage: /nudge in 20m <text> | at 17:30 <text> | every 45m <text> | every day at 9:00 <text>',
  '       /nudge list | cancel <id> | cancel all | report',
].join('\n')

const UNITS: Record<string, number> = { s: 1000, m: MINUTE, h: HOUR, d: DAY }
const DURATION = /^(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])\s*/i
const CLOCK = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?=\s|$)\s*/i

function parseDuration(input: string): { ms: number; rest: string } | null {
  let rest = input
  let ms = 0
  for (let m = DURATION.exec(rest); m; m = DURATION.exec(rest)) {
    const unit = UNITS[(m[2] ?? '').charAt(0).toLowerCase()] ?? 0
    ms += Number(m[1]) * unit
    rest = rest.slice(m[0].length).replace(/^(and|,)\s*/i, '')
  }
  return ms > 0 ? { ms: Math.round(ms), rest } : null
}

function parseClock(input: string): { hhmm: string; rest: string } | null {
  const m = CLOCK.exec(input)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] === undefined ? 0 : Number(m[2])
  const meridiem = m[3]?.toLowerCase()
  if (meridiem && (hour < 1 || hour > 12)) return null
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return null
  return { hhmm: `${pad(hour)}:${pad(minute)}`, rest: input.slice(m[0].length) }
}

/** The next local time at `hhmm` strictly after `now`. */
export function nextAt(hhmm: string, now: number): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number)
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

function cleanText(rest: string): string {
  return rest.trim().replace(/^(to|that|:|-)\s+/i, '').trim()
}

/** Reads a `/nudge` schedule (`in 20m ...`, `at 5pm ...`, `every 45m ...`, `every day at 9:00 ...`), or says what is wrong. */
export function parseWhen(input: string, now: number): When | string {
  const s = input.trim()
  let m: RegExpExecArray | null
  if ((m = /^(?:every\s+day|daily)\s+(?:at\s+)?/i.exec(s))) {
    const clock = parseClock(s.slice(m[0].length))
    if (!clock) return `I couldn't read the time in "${s}". Try "every day at 9:00 standup".`
    return withText({ due: nextAt(clock.hhmm, now), daily: clock.hhmm }, clock.rest)
  }
  if ((m = /^every\s+/i.exec(s))) {
    const dur = parseDuration(s.slice(m[0].length))
    if (!dur) return `I couldn't read how often in "${s}". Try "every 45m drink water".`
    if (dur.ms < MINUTE) return 'A repeating nudge needs at least a minute between nudges.'
    return withText({ due: now + dur.ms, everyMs: dur.ms }, dur.rest)
  }
  if ((m = /^in\s+/i.exec(s))) {
    const dur = parseDuration(s.slice(m[0].length))
    if (!dur) return `I couldn't read how long in "${s}". Try "in 20m check the deploy".`
    return withText({ due: now + dur.ms }, dur.rest)
  }
  if ((m = /^at\s+/i.exec(s))) {
    const clock = parseClock(s.slice(m[0].length))
    if (!clock) return `I couldn't read the time in "${s}". Try "at 17:30 wrap up" or "at 5pm wrap up".`
    return withText({ due: nextAt(clock.hhmm, now) }, clock.rest)
  }
  return USAGE
}

function withText(when: Omit<When, 'text'>, rest: string): When | string {
  const text = cleanText(rest)
  return text ? { ...when, text } : 'What should the nudge say? Put the text after the time.'
}

/** What is left of a nudge once it has fired at `now`: the next time a repeating one comes back. */
export function afterFiring(n: Nudge, now: number): Nudge[] {
  if (n.daily) return [{ ...n, due: nextAt(n.daily, now) }]
  if (n.everyMs) {
    const skipped = Math.floor((now - n.due) / n.everyMs) + 1
    return [{ ...n, due: n.due + skipped * n.everyMs }]
  }
  return []
}

export function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function clock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `45s`, `20m`, `1h 5m`, `2d 3h`. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** When a nudge comes, as a list row reads it: `14:32 (in 20m)`, `every 45m, next 15:10`. */
export function describe(n: Nudge, now: number): string {
  const next = `${clock(n.due)}${dayHint(n.due, now)}`
  if (n.daily) return `every day at ${n.daily}, next ${next}`
  if (n.everyMs) return `every ${span(n.everyMs)}, next ${next}`
  return `${next} (in ${span(n.due - now)})`
}

function dayHint(due: number, now: number): string {
  const a = new Date(now)
  const b = new Date(due)
  if (a.toDateString() === b.toDateString()) return ''
  a.setDate(a.getDate() + 1)
  return a.toDateString() === b.toDateString() ? ' tomorrow' : ` on ${b.getFullYear()}-${pad(b.getMonth() + 1)}-${pad(b.getDate())}`
}

export function hourLabel(h: number): string {
  if (h === 0) return 'midnight'
  if (h === 12) return 'noon'
  return h < 12 ? `${h}am` : `${h - 12}pm`
}

export function isBedtime(hour: number, bed: number, wake: number): boolean {
  if (bed === wake) return false
  return bed > wake ? hour >= bed || hour < wake : hour >= bed && hour < wake
}
