import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  inRange,
  isHeld,
  isQuiet,
  isWorkTime,
  parseDays,
  parseDuration,
  parseHHMM,
  parsePause,
  parseRange,
  readControls,
  readHold,
} from '../hooks/controls'
import { MINUTE, afterFiring, describe, parseWhen } from '../hooks/schedule'
import type { When } from '../hooks/schedule'

const HOUR = 60 * MINUTE
const SERVER = 'plugin:nudgewhen:nudgewhen'

// 2026-11-10 is a Tuesday; every time is local so the cases hold in any zone.
function localAt(hour: number, minute = 0, day = 10): number {
  return new Date(2026, 10, day, hour, minute, 0, 0).getTime()
}

function when(input: string, now = localAt(12)): When {
  const w = parseWhen(input, now)
  if (typeof w === 'string') throw new Error(`refused "${input}": ${w}`)
  return w
}

test('HH:MM reads 24-hour clock times and nothing looser', () => {
  expect(parseHHMM('09:05')).toBe(9 * 60 + 5)
  expect(parseHHMM('9:05')).toBe(9 * 60 + 5)
  expect(parseHHMM('00:00')).toBe(0)
  expect(parseHHMM('23:59')).toBe(23 * 60 + 59)
  for (const bad of ['', '24:00', '12:60', '5pm', '12', '12:5', 'ab:cd', '12:00-13:00']) expect(parseHHMM(bad)).toBeNull()
})

test('ranges may wrap midnight; equal ends are refused', () => {
  const day = parseRange('09:00-17:00')
  expect(day).toEqual({ start: 540, end: 1020 })
  expect(inRange(day!, 540)).toBe(true)
  expect(inRange(day!, 1019)).toBe(true)
  expect(inRange(day!, 1020)).toBe(false)
  expect(inRange(day!, 60)).toBe(false)
  const night = parseRange('22:00-06:00')!
  expect([23 * 60, 0, 5 * 60 + 59].map(m => inRange(night, m))).toEqual([true, true, true])
  expect([6 * 60, 12 * 60, 21 * 60 + 59].map(m => inRange(night, m))).toEqual([false, false, false])
  for (const bad of ['', '09:00', '09:00-09:00', '09:00-25:00', '9-17', '09:00 - 17:00 x']) expect(parseRange(bad)).toBeNull()
  expect(parseRange(' 09:00 - 17:00 ')).toEqual(day)
})

test('day lists read mon to sun, in any case, and nothing else', () => {
  expect(parseDays('mon,wed,fri')).toEqual([1, 3, 5])
  expect(parseDays('Sun, SAT')).toEqual([0, 6])
  expect(parseDays('tue,tue')).toEqual([2])
  for (const bad of ['', 'monday', 'mon,xyz', 'mon,,fri', ',']) expect(parseDays(bad)).toBeNull()
})

test('durations read 30m, 2h, 1h30m', () => {
  expect(parseDuration('30m')).toBe(30 * MINUTE)
  expect(parseDuration('2h')).toBe(2 * HOUR)
  expect(parseDuration('1h30m')).toBe(90 * MINUTE)
  expect(parseDuration(' 45M ')).toBe(45 * MINUTE)
  for (const bad of ['', '0m', '30', 'm', '1x', '30m soon', '1h 30m x', '-5m']) expect(parseDuration(bad)).toBeNull()
})

test('settings: defaults, valid values, and a fallback with a warning for each bad key', () => {
  const ok = readControls({ bedtime: '22:30', wake: '06:15', work_hours: '09:00-17:00', work_days: 'mon,tue', quiet_hours: '12:00-13:00' })
  expect(ok.warnings).toEqual([])
  expect(ok.controls).toEqual({
    bedMin: 22 * 60 + 30,
    wakeMin: 6 * 60 + 15,
    work: { start: 540, end: 1020 },
    workDays: [1, 2],
    quiet: { start: 720, end: 780 },
  })

  const none = readControls({})
  expect(none.warnings).toEqual([])
  expect(none.controls).toEqual({ bedMin: 23 * 60, wakeMin: 5 * 60, work: null, workDays: null, quiet: null })

  const bad = readControls({ bedtime: '25:00', wake: 'dawn', work_hours: '9-5', work_days: 'monday', quiet_hours: '1' })
  expect(bad.controls).toEqual(none.controls)
  expect(bad.warnings.map(w => w.key)).toEqual(['bedtime', 'wake', 'work_hours', 'work_days', 'quiet_hours'])
  expect(bad.warnings[0]?.text).toMatch(/bedtime/)
  expect(bad.warnings[0]?.text).toMatch(/23:00/)
  expect(bad.warnings[1]?.text).toMatch(/05:00/)
})

test('work hours and days bound the break nudges; quiet hours hold', () => {
  const c = readControls({ work_hours: '09:00-17:00', work_days: 'mon,tue', quiet_hours: '12:00-13:00' }).controls
  expect(isWorkTime(c, localAt(10))).toBe(true)
  expect(isWorkTime(c, localAt(18))).toBe(false)
  expect(isWorkTime(c, localAt(10, 0, 11))).toBe(false)
  expect(isWorkTime(readControls({}).controls, localAt(3, 0, 14))).toBe(true)
  expect(isQuiet(c, localAt(12, 30))).toBe(true)
  expect(isQuiet(c, localAt(13))).toBe(false)
  expect(isQuiet(readControls({}).controls, localAt(12))).toBe(false)
})

test('the hold is { until }: null means until resume, a number until then', () => {
  const now = localAt(12)
  expect(readHold(undefined)).toBeUndefined()
  expect(readHold('x')).toBeUndefined()
  expect(readHold({ until: 'soon' })).toBeUndefined()
  expect(readHold({ until: null })).toEqual({ until: null })
  expect(isHeld(readHold({ until: null }), now)).toBe(true)
  expect(isHeld({ until: now + 1 }, now)).toBe(true)
  expect(isHeld({ until: now }, now)).toBe(false)
  expect(isHeld(undefined, now)).toBe(false)
})

test('pause: no argument is until resume, until HH:MM the next such time, tomorrow the next wake', () => {
  const now = localAt(12)
  const wake = 5 * 60
  expect(parsePause('', now, wake)).toEqual({ until: null })
  expect(parsePause('until 14:30', now, wake)).toEqual({ until: localAt(14, 30) })
  expect(parsePause('until 09:00', now, wake)).toEqual({ until: localAt(9, 0, 11) })
  expect(parsePause('tomorrow', now, wake)).toEqual({ until: localAt(5, 0, 11) })
  expect(parsePause('until noon-ish', now, wake)).toBeNull()
  expect(parsePause('later', now, wake)).toBeNull()
})

test('repeats: every weekday at, and every mon,wed,fri at', () => {
  const w = when('every weekday at 9:00 standup', localAt(12, 0, 13))
  expect(w).toEqual({ due: localAt(9, 0, 16), daily: '09:00', days: [1, 2, 3, 4, 5], text: 'standup' })
  const m = when('every mon,wed,fri at 17:30 wrap up')
  expect(m.days).toEqual([1, 3, 5])
  expect(m.daily).toBe('17:30')
  expect(m.due).toBe(localAt(17, 30, 11))
  expect(parseWhen('every mon,xyz at 9:00 x', localAt(12))).toMatch(/couldn't read/)
  expect(parseWhen('every weekday at nine x', localAt(12))).toMatch(/couldn't read the time/)
})

test('a weekday repeat skips the weekend, and says so in the list', () => {
  const friday = localAt(9, 0, 13)
  const n = { id: 1, ...when('every weekday at 9:00 standup', localAt(8, 0, 13)) }
  expect(n.due).toBe(friday)
  const [next] = afterFiring(n, friday)
  expect(next?.due).toBe(localAt(9, 0, 16))
  expect(describe(n, localAt(8, 0, 13))).toMatch(/^every weekday at 09:00, next 09:00$/)
  const mwf = { id: 2, ...when('every mon,wed,fri at 17:30 x') }
  expect(describe(mwf, localAt(12))).toMatch(/^every mon,wed,fri at 17:30, next 17:30 tomorrow$/)
})

/** The engine beneath the mod: idle machine, recorded toasts, notifications and config writes, hosted polls on demand. */
function world(on: On, now: number, entries: Record<string, unknown> = {}, hostedNudges: unknown[] = [], configError?: string) {
  const clock = mock.clock(on, { now })
  mock.store(on, entries)
  const shown = {
    toasts: [] as string[],
    notified: [] as string[],
    status: undefined as string | undefined,
    config: [] as { key: string; value: unknown }[],
    polls: 0,
  }
  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nudgewhen__${e.name}` } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '|   "HIDIdleTime" = 1000000000\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.toast', (_, e) => {
    shown.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    shown.notified.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  on('ui.status', (_, e) => {
    shown.status = e.text
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
  on('config.set', (_, e) => {
    if (configError !== undefined) throw new Error(configError)
    shown.config.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: SERVER } }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'poll_nudges') {
      shown.polls += 1
      const text = JSON.stringify({ nudges: hostedNudges })
      return { value: { content: [{ type: 'text', text }], isError: false } }
    }
    return { value: { content: [{ type: 'text', text: '{}' }], isError: false } }
  })
  return { clock, shown }
}

function nudge($: Engine, args: string) {
  return $.command.run({
    command: 'nudge',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
}

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive })

test('bedtime and wake are HH:MM settings', { options: { bedtime: '22:30', wake: '06:00' } }, async ($, on) => {
  const { clock, shown } = world(on, localAt(22, 15))
  await start($)
  await clock.settle()
  expect(shown.status).toBe('bed in 15m')
  await clock.advance(20 * MINUTE)
  expect(shown.status).toBe('past 22:30 · time to wrap up')
})

test('a bad setting falls back to its default and toasts once, naming the key and the default', { options: { bedtime: '25:00' } }, async ($, on) => {
  const { clock, shown } = world(on, localAt(23, 30))
  await start($)
  await clock.settle()
  await clock.advance(2 * MINUTE)
  expect(shown.status).toBe('past 11pm · time to wrap up')
  expect(shown.toasts.length).toBe(1)
  expect(shown.toasts[0]).toMatch(/bedtime/)
  expect(shown.toasts[0]).toMatch(/23:00/)
})

test('work hours bound the break nudges', { options: { work_hours: '09:00-17:00' } }, async ($, on) => {
  const inside = localAt(12)
  const sit = (now: number) => ({ sitStart: now - 40 * MINUTE, awayStart: null, updated: now })
  const a = world(on, inside, { sit: sit(inside) })
  await start($)
  await a.clock.settle()
  expect(a.shown.status).toBe('sat 40m')
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' })
  expect(a.shown.toasts.length).toBe(1)
})

test('outside work hours there is no break nudge, on the status line or at an agent launch', { options: { work_hours: '09:00-17:00' } }, async ($, on) => {
  const now = localAt(20)
  const { clock, shown } = world(on, now, { sit: { sitStart: now - 40 * MINUTE, awayStart: null, updated: now } })
  await start($)
  await clock.settle()
  expect(shown.status).toBe(undefined)
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' })
  expect(shown.toasts).toEqual([])
})

test('work days bound the break nudges (Tuesday here)', { options: { work_days: 'mon,wed' } }, async ($, on) => {
  const now = localAt(12)
  const { clock, shown } = world(on, now, { sit: { sitStart: now - 40 * MINUTE, awayStart: null, updated: now } })
  await start($)
  await clock.settle()
  expect(shown.status).toBe(undefined)
})

test('work hours leave bedtime and reminders alone', { options: { work_hours: '09:00-17:00' } }, async ($, on) => {
  const now = localAt(23, 30)
  const { clock, shown } = world(on, now, { nudges: [{ id: 1, text: 'tea', due: now - 1000 }] })
  await start($)
  await clock.settle()
  expect(shown.toasts).toEqual(['nudge: tea'])
  expect(shown.status).toBe('nudge: tea  ·  past 11pm · time to wrap up')
})

test('quiet hours hold toasts and notifications, the status still shows, and a held reminder fires once after', { options: { quiet_hours: '11:30-13:00' } }, async ($, on) => {
  const now = localAt(12)
  const nudges = [{ id: 1, text: 'tea', due: now - MINUTE }, { id: 2, text: 'water', due: now + 5 * MINUTE, everyMs: 5 * MINUTE }]
  const sit = { sitStart: now - 40 * MINUTE, awayStart: null, updated: now }
  const { clock, shown } = world(on, now, { nudges, sit })
  await start($)
  await clock.settle()
  await clock.advance(30 * MINUTE)
  expect(shown.toasts).toEqual([])
  expect(shown.notified).toEqual([])
  expect(shown.status).toMatch(/^sat 7\dm/)
  await clock.advance(32 * MINUTE)
  expect(shown.toasts.filter(t => /tea/.test(t)).length).toBe(1)
  expect(shown.toasts.filter(t => /water/.test(t)).length).toBe(1)
  expect(shown.notified.length).toBe(2)
})

test('quiet hours also hold hosted nudges', { options: { quiet_hours: '11:30-13:00' } }, async ($, on) => {
  const now = localAt(12)
  const hosted = [{ id: 'h1', source: 'calendar', text: 'standup', due: now }]
  const { clock, shown } = world(on, now, {}, hosted)
  await start($)
  await clock.settle()
  await clock.advance(10 * MINUTE)
  expect(shown.toasts).toEqual([])
  expect(shown.notified).toEqual([])
  await clock.advance(60 * MINUTE)
  expect(shown.toasts).toEqual(['nudge (calendar): standup'])
})

test('/nudge snooze holds everything for the duration, then a due reminder fires once', async ($, on) => {
  const now = localAt(12)
  const { clock, shown } = world(on, now, { nudges: [{ id: 1, text: 'tea', due: now + 5 * MINUTE, everyMs: 5 * MINUTE }] })
  await start($)
  await clock.settle()
  expect((await nudge($, 'snooze 30m')).text).toBe('Snoozed until 12:30.')
  await clock.advance(25 * MINUTE)
  expect(shown.toasts).toEqual([])
  expect((await nudge($, 'list')).text).toMatch(/Held until 12:30/)
  await clock.advance(6 * MINUTE)
  expect(shown.toasts.length).toBe(1)
  expect(shown.notified.length).toBe(1)
  expect((await nudge($, 'list')).text).not.toMatch(/Held/)
})

test('/nudge snooze refuses what is not a duration', async ($, on) => {
  world(on, localAt(12))
  await start($, false)
  expect((await nudge($, 'snooze')).text).toMatch(/Try "\/nudge snooze 30m"/)
  expect((await nudge($, 'snooze soon')).text).toMatch(/Try "\/nudge snooze 30m"/)
})

test('/nudge pause holds until resume; resume clears it', async ($, on) => {
  const now = localAt(12)
  const { clock, shown } = world(on, now, { nudges: [{ id: 1, text: 'tea', due: now + 5 * MINUTE }] })
  await start($)
  await clock.settle()
  expect((await nudge($, 'pause')).text).toBe('Paused until /nudge resume.')
  await clock.advance(3 * HOUR)
  expect(shown.toasts).toEqual([])
  expect((await nudge($, 'resume')).text).toBe('Resumed. Nudges are on.')
  await clock.advance(MINUTE)
  expect(shown.toasts.length).toBe(1)
  expect((await nudge($, 'resume')).text).toBe('Nothing was paused.')
})

test('/nudge pause until HH:MM and pause tomorrow', async ($, on) => {
  world(on, localAt(12))
  await start($, false)
  expect((await nudge($, 'pause until 14:30')).text).toBe('Paused until 14:30.')
  expect((await nudge($, 'pause tomorrow')).text).toBe('Paused until 05:00 tomorrow.')
  expect((await nudge($, 'pause until never')).text).toMatch(/Try "\/nudge pause until 14:30"/)
})

test('/nudge bedtime, wake, hours, days and quiet validate, then write through config.set', async ($, on) => {
  const { shown } = world(on, localAt(12))
  await start($, false)

  expect((await nudge($, 'bedtime 22:45')).text).toBe('Bedtime is now 22:45.')
  expect((await nudge($, 'wake 6:30')).text).toBe('Wake-up is now 06:30.')
  expect((await nudge($, 'hours 09:00-17:00')).text).toBe('Work hours are now 09:00-17:00.')
  expect((await nudge($, 'days mon,tue,fri')).text).toBe('Work days are now mon,tue,fri.')
  expect((await nudge($, 'quiet 12:00-13:00')).text).toBe('Quiet hours are now 12:00-13:00.')
  expect(shown.config).toEqual([
    { key: 'nudgewhen.bedtime', value: '22:45' },
    { key: 'nudgewhen.wake', value: '06:30' },
    { key: 'nudgewhen.work_hours', value: '09:00-17:00' },
    { key: 'nudgewhen.work_days', value: 'mon,tue,fri' },
    { key: 'nudgewhen.quiet_hours', value: '12:00-13:00' },
  ])

  shown.config.length = 0
  expect((await nudge($, 'bedtime 25:00')).text).toMatch(/Usage: \/nudge bedtime HH:MM/)
  expect((await nudge($, 'bedtime')).text).toMatch(/Usage: \/nudge bedtime HH:MM/)
  expect((await nudge($, 'hours 9-5')).text).toMatch(/Usage: \/nudge hours HH:MM-HH:MM/)
  expect((await nudge($, 'days monday')).text).toMatch(/Usage: \/nudge days mon,tue/)
  expect((await nudge($, 'quiet 5')).text).toMatch(/Usage: \/nudge quiet HH:MM-HH:MM/)
  expect(shown.config).toEqual([])
})

test('a config row the engine does not have answers with a message and keeps the command alive', async ($, on) => {
  world(on, localAt(12), {}, [], 'no /config row with key nudgewhen.status_segments')
  await start($, false)
  const text = (await nudge($, 'status sit,bed')).text
  expect(text).toMatch(/^Could not change status_segments: /)
  expect(text).toMatch(/Set it in \/config instead\.$/)
})

test('an empty hours, days or quiet clears the setting', async ($, on) => {
  const { shown } = world(on, localAt(12))
  await start($, false)
  expect((await nudge($, 'hours')).text).toBe('Work hours cleared: break nudges run all day.')
  expect((await nudge($, 'days')).text).toBe('Work days cleared: break nudges run every day.')
  expect((await nudge($, 'quiet')).text).toBe('Quiet hours cleared.')
  expect(shown.config).toEqual([
    { key: 'nudgewhen.work_hours', value: '' },
    { key: 'nudgewhen.work_days', value: '' },
    { key: 'nudgewhen.quiet_hours', value: '' },
  ])
})

test('/nudge every weekday at sets a repeat that the list reads back', async ($, on) => {
  world(on, localAt(12))
  await start($, false)
  const r = await nudge($, 'every weekday at 9:00 standup')
  expect(r.text).toBe('Nudge #1 set for every weekday at 09:00, next 09:00 tomorrow: standup')
})
