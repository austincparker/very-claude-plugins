import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { KINDS, STARTER, fill, kindForSource, parseLine, pickLine, readLines, readTone } from '../hooks/lines'
import { MINUTE } from '../hooks/schedule'

const SERVER = 'plugin:nudgewhen:nudgewhen'

function localAt(hour: number, minute = 0, day = 10): number {
  return new Date(2026, 10, day, hour, minute, 0, 0).getTime()
}


const filled = (kind: keyof typeof STARTER, vars: { minutes?: number; text?: string }) => STARTER[kind].map(l => fill(l, vars))

test('tone is plain unless the setting is exactly vulgar', () => {
  expect(readTone(undefined)).toBe('plain')
  expect(readTone('')).toBe('plain')
  expect(readTone('rude')).toBe('plain')
  expect(readTone('vulgar')).toBe('vulgar')
  expect(readTone(' Vulgar ')).toBe('vulgar')
})

test('hosted sources map to the kinds register.ts labels them with', () => {
  expect(kindForSource('ci')).toBe('ci')
  expect(kindForSource('review_requested')).toBe('review')
  expect(kindForSource('review_submitted')).toBe('review')
  expect(kindForSource('pr_landed')).toBe('landed')
  expect(kindForSource('calendar')).toBe('any')
})

test('fill puts the minutes and the text into a line and leaves other braces alone', () => {
  expect(fill('sat {minutes}m: {text} {x}', { minutes: 42, text: 'ci red' })).toBe('sat 42m: ci red {x}')
  expect(fill('{text}{text}', { text: 'a' })).toBe('aa')
  expect(fill('{minutes} min', {})).toBe('{minutes} min')
})

test('every kind has starter lines, each clean and within the limits', () => {
  for (const kind of KINDS) {
    const lines = STARTER[kind as keyof typeof STARTER] ?? []
    if (kind === 'any') expect(lines.length).toBeGreaterThan(0)
    else expect(lines.length).toBeGreaterThanOrEqual(3)
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(200)
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u001f]/.test(l)).toBe(false)
    }
  }
})

test('parseLine takes a kind and text, strips control characters, and refuses the rest', () => {
  expect(parseLine('ci the build is fucked: {text}')).toEqual({ kind: 'ci', text: 'the build is fucked: {text}' })
  expect(parseLine('ANY  hello\u001b[31m there')).toEqual({ kind: 'any', text: 'hello [31m there' })
  expect(typeof parseLine('nope some text')).toBe('string')
  expect(typeof parseLine('ci')).toBe('string')
  expect(typeof parseLine('ci   ')).toBe('string')
  expect(typeof parseLine(`ci ${'x'.repeat(201)}`)).toBe('string')
  expect(parseLine(`ci ${'x'.repeat(200)}`)).toEqual({ kind: 'ci', text: 'x'.repeat(200) })
})

test('readLines keeps well-formed stored lines only, at most 200', () => {
  expect(readLines('x')).toEqual([])
  expect(readLines([{ kind: 'ci', text: 'a' }, { kind: 'zzz', text: 'b' }, { kind: 'sit', text: 5 }, null])).toEqual([{ kind: 'ci', text: 'a' }])
  const many = Array.from({ length: 300 }, (_, i) => ({ kind: 'any', text: `l${i}` }))
  expect(readLines(many).length).toBe(200)
})

test('pickLine prefers the kind, then any, then the starter set', () => {
  const mine = [{ kind: 'ci', text: 'mine-ci' }, { kind: 'any', text: 'mine-any' }]
  expect(pickLine(mine, 'ci')).toBe('mine-ci')
  expect(pickLine(mine, 'bed')).toBe('mine-any')
  expect(STARTER.bed).toContain(pickLine([], 'bed'))
  expect(STARTER.ci).toContain(pickLine([{ kind: 'bed', text: 'z' }], 'ci'))
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
    calls: [] as string[],
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
    shown.calls.push(JSON.stringify(e))
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

const hostedCi = (now: number) => [{ id: 'h1', source: 'ci', text: 'main is red', due: now }]

test('plain tone leaves every text as it was', async ($, on) => {
  const now = localAt(12)
  const { clock, shown } = world(on, now, { nudges: [{ id: 1, text: 'tea', due: now - 1000 }], lines: [{ kind: 'any', text: 'ignored {text}' }] }, hostedCi(now))
  await start($)
  await clock.settle()
  await clock.advance(2 * MINUTE)
  expect(shown.toasts).toContain('nudge: tea')
  expect(shown.toasts).toContain('nudge (ci): main is red')
  expect(shown.notified).toContain('main is red')
})

test('vulgar tone says the user own line for the kind, filling the hosted text', { options: { tone: 'vulgar' } }, async ($, on) => {
  const now = localAt(12)
  const { clock, shown } = world(on, now, { lines: [{ kind: 'ci', text: 'holy shit, {text}' }, { kind: 'any', text: 'whatever' }] }, hostedCi(now))
  await start($)
  await clock.settle()
  await clock.advance(2 * MINUTE)
  expect(shown.toasts).toEqual(['holy shit, main is red'])
  expect(shown.notified).toEqual(['holy shit, main is red'])
})

test('vulgar tone falls back to any, and a reminder fills its text', { options: { tone: 'vulgar' } }, async ($, on) => {
  const now = localAt(12)
  const a = world(on, now, { lines: [{ kind: 'any', text: 'move, you lump: {text}' }], nudges: [{ id: 1, text: 'tea', due: now - 1000 }] })
  await start($)
  await a.clock.settle()
  expect(a.shown.toasts).toEqual(['move, you lump: tea'])
})

test('vulgar tone with no lines uses the starter set for the kind', { options: { tone: 'vulgar' } }, async ($, on) => {
  const now = localAt(12)
  const { clock, shown } = world(on, now, {}, hostedCi(now))
  await start($)
  await clock.settle()
  await clock.advance(2 * MINUTE)
  expect(shown.toasts.length).toBe(1)
  expect(filled('ci', { text: 'main is red' })).toContain(shown.toasts[0])
})

test('the agent-launch break toast fills the minutes from a break line', { options: { tone: 'vulgar' } }, async ($, on) => {
  const now = localAt(12)
  const { clock, shown } = world(on, now, { sit: { sitStart: now - 40 * MINUTE, awayStart: null, updated: now }, lines: [{ kind: 'break', text: '{minutes} minutes on your ass' }] })
  await start($)
  await clock.settle()
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' })
  expect(shown.toasts).toEqual(['40 minutes on your ass'])
})

test('the status entry and /nudge list keep plain wording under vulgar tone', { options: { tone: 'vulgar' } }, async ($, on) => {
  const now = localAt(23, 30)
  const { clock, shown } = world(on, now, { nudges: [{ id: 1, text: 'tea', due: now + 5 * MINUTE }], lines: [{ kind: 'bed', text: 'go to fucking bed' }] })
  await start($)
  await clock.settle()
  expect(shown.status).toBe('past 11pm · time to wrap up')
  expect((await nudge($, 'list')).text).toMatch(/#1 .*tea/)
  expect(JSON.stringify(shown)).not.toMatch(/fucking/)
})

test('/nudge tone writes the setting and refuses anything else', async ($, on) => {
  const { shown } = world(on, localAt(12))
  await start($, false)
  expect((await nudge($, 'tone vulgar')).text).toBe('Tone is now vulgar.')
  expect((await nudge($, 'tone plain')).text).toBe('Tone is now plain.')
  expect(shown.config).toEqual([{ key: 'nudgewhen.tone', value: 'vulgar' }, { key: 'nudgewhen.tone', value: 'plain' }])
  shown.config.length = 0
  expect((await nudge($, 'tone rude')).text).toMatch(/Usage: \/nudge tone plain\|vulgar/)
  expect((await nudge($, 'tone')).text).toMatch(/Usage: \/nudge tone plain\|vulgar/)
  expect(shown.config).toEqual([])
})

test('/nudge tone vulgar takes effect at once', async ($, on) => {
  const now = localAt(12)
  const { clock, shown } = world(on, now, { nudges: [{ id: 1, text: 'tea', due: now + 5 * MINUTE }], lines: [{ kind: 'any', text: 'fuck, {text}' }] })
  await start($)
  await clock.settle()
  await nudge($, 'tone vulgar')
  await clock.advance(6 * MINUTE)
  expect(shown.toasts).toEqual(['fuck, tea'])
})

test('/nudge line add, list and rm keep the lines in the store', async ($, on) => {
  const { shown } = world(on, localAt(12))
  await start($, false)
  expect((await nudge($, 'line add ci the build shat itself: {text}')).text).toBe('Added line #1 (ci).')
  expect((await nudge($, 'line add any get up, you lump')).text).toBe('Added line #2 (any).')
  expect((await nudge($, 'line list')).text).toBe('Lines:\n  #1  ci  the build shat itself: {text}\n  #2  any  get up, you lump')
  expect((await nudge($, 'line list ci')).text).toBe('Lines:\n  #1  ci  the build shat itself: {text}')
  expect((await nudge($, 'line list bed')).text).toMatch(/No lines/)
  expect((await nudge($, 'line rm 1')).text).toBe('Removed line #1: the build shat itself: {text}')
  expect((await nudge($, 'line list')).text).toBe('Lines:\n  #1  any  get up, you lump')
  expect((await nudge($, 'line rm 9')).text).toMatch(/No line #9/)
  expect((await nudge($, 'line rm x')).text).toMatch(/Usage: \/nudge line rm <n>/)
  expect(shown.config).toEqual([])
})

test('/nudge line refuses a bad kind, empty text and long text, and stops at 200 lines', async ($, on) => {
  world(on, localAt(12), { lines: Array.from({ length: 200 }, (_, i) => ({ kind: 'any', text: `l${i}` })) })
  await start($, false)
  expect((await nudge($, 'line add any one more')).text).toMatch(/200 lines/)
  expect((await nudge($, 'line add nope text')).text).toMatch(/Usage: \/nudge line add/)
  expect((await nudge($, 'line add ci')).text).toMatch(/Usage: \/nudge line add/)
  expect((await nudge($, `line add ci ${'x'.repeat(201)}`)).text).toMatch(/200 characters/)
  expect((await nudge($, 'line')).text).toMatch(/Usage: \/nudge line/)
})

test('lines never leave the machine', async ($, on) => {
  const now = localAt(12)
  const { clock, shown } = world(on, now, {}, hostedCi(now))
  await start($, false)
  await nudge($, 'line add any secret-banter-xyz')
  await nudge($, 'tone vulgar')
  await clock.advance(10 * MINUTE)
  expect(shown.calls.join('')).not.toMatch(/secret-banter-xyz/)
})
