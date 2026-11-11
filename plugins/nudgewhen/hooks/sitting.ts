import { MINUTE, pad } from './schedule'

/** Shared by every session through the store; one session at a time samples. */
export type Sit = {
  sitStart: number | null
  awayStart: number | null
  updated: number
  sampler?: string
}

export type LogRow = [at: string, kind: 'sit' | 'break', minutes: number]

export const SAMPLE_MS = MINUTE
/** A reading older than this means nobody sampled: the machine slept or no session ran. */
export const STALE_MS = 3 * SAMPLE_MS
const TAKEOVER_MS = 1.5 * SAMPLE_MS

export function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

export function readSit(v: unknown): Sit {
  const o = v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  return {
    sitStart: num(o.sitStart),
    awayStart: num(o.awayStart),
    updated: num(o.updated) ?? 0,
    sampler: typeof o.sampler === 'string' ? o.sampler : undefined,
  }
}

export function isSampler(s: Sit, sessionId: string, now: number): boolean {
  return s.sampler === undefined || s.sampler === sessionId || now - s.updated > TAKEOVER_MS
}

/** One sample: `idleMs` since the last keyboard or mouse input, a break being `awayMs` of it. */
export function step(prev: Sit, idleMs: number, now: number, awayMs: number): { sit: Sit; log: LogRow[] } {
  const s = { ...prev }
  const log: LogRow[] = []
  const slept = s.updated > 0 && now - s.updated > STALE_MS
  const awayFrom = idleMs >= awayMs ? now - idleMs : slept ? s.updated : null
  if (awayFrom !== null && s.sitStart !== null) {
    log.push([localStamp(s.sitStart), 'sit', minutes(awayFrom - s.sitStart)])
    s.sitStart = null
    s.awayStart = awayFrom
  }
  if (idleMs < awayMs && s.sitStart === null) {
    const back = now - idleMs
    if (s.awayStart !== null) log.push([localStamp(s.awayStart), 'break', minutes(back - s.awayStart)])
    s.sitStart = back
    s.awayStart = null
  }
  s.updated = now
  return { sit: s, log }
}

export function satMinutes(s: Sit, now: number): number | null {
  if (s.sitStart === null || now - s.updated > STALE_MS) return null
  return minutes(now - s.sitStart)
}

function minutes(ms: number): number {
  return Math.max(0, Math.floor(ms / MINUTE))
}

export function localStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function readLog(v: unknown): LogRow[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (r): r is LogRow =>
      Array.isArray(r) && typeof r[0] === 'string' && (r[1] === 'sit' || r[1] === 'break') && typeof r[2] === 'number',
  )
}

export function report(rows: readonly LogRow[]): string {
  const days = new Map<string, { sits: number[]; breaks: number }>()
  for (const [at, kind, mins] of rows) {
    const day = days.get(at.slice(0, 10)) ?? { sits: [], breaks: 0 }
    if (kind === 'sit') day.sits.push(mins)
    else day.breaks += 1
    days.set(at.slice(0, 10), day)
  }
  if (days.size === 0) return 'No sitting log yet. It fills in as you work.'
  const lines = ['day         breaks  longest sit  average sit']
  for (const [day, d] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    const longest = d.sits.length ? Math.max(...d.sits) : 0
    const average = d.sits.length ? Math.round(d.sits.reduce((a, b) => a + b, 0) / d.sits.length) : 0
    lines.push(`${day}  ${String(d.breaks).padStart(6)}  ${`${longest}m`.padStart(11)}  ${`${average}m`.padStart(11)}`)
  }
  return lines.join('\n')
}
