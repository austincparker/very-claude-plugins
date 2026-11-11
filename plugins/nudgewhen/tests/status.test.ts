import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MINUTE } from '../hooks/schedule'
import { DEFAULT_SEGMENTS, FREE, PAID, bedText, contextText, costText, limitsText, parseSegments, paidText } from '../hooks/status'

function localAt(hour: number, minute = 0): number {
  return new Date(2026, 10, 10, hour, minute, 0, 0).getTime()
}

type Usage = {
  startedAt: number
  context: { window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number }[]
  cost?: { usd: number }
}

const USAGE: Usage = {
  startedAt: 0,
  context: { window: 200000, percent: 42 },
  rateLimits: [
    { kind: 'seven_day', percentUsed: 40 },
    { kind: 'five_hour', percentUsed: 82.5 },
  ],
  cost: { usd: 1.234 },
}

/** The engine beneath the mod: an idle machine, a session with usage and a model, and `git` answering as scripted. */
function world(on: On, now: number, entries: Record<string, unknown> = {}, opts: { usage?: Usage; branch?: string | null } = {}) {
  const clock = mock.clock(on, { now })
  mock.store(on, entries)
  const shown = { status: undefined as string | undefined, toasts: [] as string[], config: [] as { key: string; value: unknown }[], git: 0 }
  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: opts.usage ?? USAGE }))
  on('session.model', () => ({ value: 'claude-opus-5' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nudgewhen__${e.name}` } }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') {
      shown.git += 1
      const branch = opts.branch === undefined ? 'feature-x' : opts.branch
      return {
        value: { exitCode: branch === null ? 128 : 0, stdout: branch === null ? '' : `${branch}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      }
    }
    return {
      value: { exitCode: 0, stdout: '|   "HIDIdleTime" = 1000000000\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.toast', (_, e) => {
    shown.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('ui.status', (_, e) => {
    shown.status = e.text
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
  on('config.set', (_, e) => {
    shown.config.push({ key: e.key, value: e.value })
    return { value: e.value }
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

const start = async ($: Engine, clock: { settle: () => Promise<unknown> }) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

test('the default is sit, bed, hosted, and the free and paid names are fixed', () => {
  expect(DEFAULT_SEGMENTS).toBe('sit,bed,hosted')
  expect(FREE).toEqual(['sit', 'break', 'next', 'bed', 'breaks', 'context', 'limits', 'cost', 'model', 'branch'])
  expect(PAID).toEqual(['hosted', 'ci', 'reviews'])
})

test('parseSegments keeps order, drops unknown names and repeats', () => {
  expect(parseSegments('model, Cost ,bogus,model,hosted')).toEqual(['model', 'cost', 'hosted'])
  expect(parseSegments('')).toEqual([])
})

test('the paid segments render nothing until the hosted server is connected', () => {
  for (const name of PAID) expect(paidText(name)).toBe('')
})

test('formatters: context percent, the limit closest to its cap, cost in dollars', () => {
  expect(contextText(42)).toBe('ctx 42%')
  expect(contextText(undefined)).toBe('')
  expect(limitsText([])).toBe('')
  expect(limitsText([{ kind: 'seven_day', percentUsed: 40 }, { kind: 'five_hour', percentUsed: 82.5 }])).toBe('5h 82.5%')
  expect(limitsText([{ kind: 'seven_day', percentUsed: 91 }, { kind: 'five_hour', percentUsed: 12 }])).toBe('7d 91%')
  expect(limitsText([{ kind: 'spend_limit', percentUsed: 5 }])).toBe('spend_limit 5%')
  expect(costText(1.234)).toBe('$1.23')
  expect(costText(undefined)).toBe('')
})

test('bed: a countdown in the last two hours, the wrap-up text past bedtime, nothing otherwise', () => {
  const bed = 23 * 60
  const wake = 5 * 60
  expect(bedText(localAt(21, 30), bed, wake)).toBe('bed in 1h 30m')
  expect(bedText(localAt(20, 59), bed, wake)).toBe('')
  expect(bedText(localAt(23, 30), bed, wake)).toBe('past 11pm · time to wrap up')
  expect(bedText(localAt(22, 45), 22 * 60 + 30, wake)).toBe('past 22:30 · time to wrap up')
  expect(bedText(localAt(12), bed, wake)).toBe('')
})

test('status_segments sets the order and the content', { options: { status_segments: 'model,context,limits,cost' } }, async ($, on) => {
  const { clock, shown } = world(on, localAt(12))
  await start($, clock)
  expect(shown.status).toBe('claude-opus-5  ·  ctx 42%  ·  5h 82.5%  ·  $1.23')
})

test('unknown names are skipped and an empty segment drops out with its separator', { options: { status_segments: 'bogus,cost,branch,model' } }, async ($, on) => {
  const { clock, shown } = world(on, localAt(12), {}, { branch: null })
  await start($, clock)
  expect(shown.status).toBe('$1.23  ·  claude-opus-5')
})

test('paid segments stay empty', { options: { status_segments: 'hosted,ci,reviews,model' } }, async ($, on) => {
  const { clock, shown } = world(on, localAt(12))
  await start($, clock)
  expect(shown.status).toBe('claude-opus-5')
})

test('the default segments still read the sit and the bedtime', async ($, on) => {
  const now = localAt(23, 30)
  const { clock, shown } = world(on, now, { sit: { sitStart: now - 65 * MINUTE, awayStart: null, updated: now } })
  await start($, clock)
  expect(shown.status).toBe('sat 65m · stand up  ·  past 11pm · time to wrap up')
})

test('the branch comes from git and is looked up once a minute', { options: { status_segments: 'branch' } }, async ($, on) => {
  const { clock, shown } = world(on, localAt(12))
  await start($, clock)
  expect(shown.status).toBe('feature-x')
  expect(shown.git).toBe(1)
  await clock.advance(45_000)
  expect(shown.git).toBe(1)
  await clock.advance(20_000)
  expect(shown.git).toBe(2)
})

test('outside a git repo the branch is blank', { options: { status_segments: 'branch' } }, async ($, on) => {
  const { clock, shown } = world(on, localAt(12), {}, { branch: null })
  await start($, clock)
  expect(shown.status).toBe(undefined)
})

test('break counts down to the next break nudge; next names the next reminder; breaks counts today', { options: { status_segments: 'break,next,breaks' } }, async ($, on) => {
  const now = localAt(12)
  const entries = {
    sit: { sitStart: now - 18 * MINUTE, awayStart: null, updated: now },
    nudges: [{ id: 1, text: 'wrap up the invoice and send it to the client', due: localAt(17, 30) }, { id: 2, text: 'later', due: localAt(18) }],
    log: [
      ['2026-11-09T10:00', 'break', 6],
      ['2026-11-10T09:00', 'break', 6],
      ['2026-11-10T10:00', 'sit', 40],
      ['2026-11-10T11:00', 'break', 7],
    ],
  }
  const { clock, shown } = world(on, now, entries)
  await start($, clock)
  expect(shown.status).toBe('break in 12m  ·  next 17:30 wrap up the invoice and…  ·  breaks 2')
})

test('break is empty once the sit passes the limit', { options: { status_segments: 'break,model' } }, async ($, on) => {
  const now = localAt(12)
  const { clock, shown } = world(on, now, { sit: { sitStart: now - 40 * MINUTE, awayStart: null, updated: now } })
  await start($, clock)
  expect(shown.status).toBe('claude-opus-5')
})

test('bed counts down in the last two hours', { options: { status_segments: 'bed' } }, async ($, on) => {
  const { clock, shown } = world(on, localAt(21, 30))
  await start($, clock)
  expect(shown.status).toBe('bed in 1h 30m')
})

test('a usage with no context reading or cost leaves those segments out', { options: { status_segments: 'context,cost,limits,model' } }, async ($, on) => {
  const { clock, shown } = world(on, localAt(12), {}, { usage: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } })
  await start($, clock)
  expect(shown.status).toBe('claude-opus-5')
})

test('/nudge status alone names the current list and every known segment', async ($, on) => {
  world(on, localAt(12))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  const r = (await nudge($, 'status')).text
  expect(r).toMatch(/Status line: sit,bed,hosted/)
  for (const name of [...FREE, ...PAID]) expect(r).toContain(name)
})

test('/nudge status <list> validates, then writes through config.set', async ($, on) => {
  const { shown } = world(on, localAt(12))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  expect((await nudge($, 'status Model, cost')).text).toBe('Status line is now: model,cost.')
  expect(shown.config).toEqual([{ key: 'nudgewhen.status_segments', value: 'model,cost' }])

  shown.config.length = 0
  const bad = (await nudge($, 'status model,foo,bar')).text
  expect(bad).toMatch(/Unknown: foo, bar/)
  expect(bad).toContain('limits')
  expect(shown.config).toEqual([])
})
