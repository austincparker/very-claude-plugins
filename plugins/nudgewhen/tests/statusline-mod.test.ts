import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { STATE_DIR } from '../hooks/statusline'

const NOW = new Date(2026, 10, 10, 12, 0, 0, 0).getTime()
const LAUNCHER = `'/p'/bin/statusline wrap "${STATE_DIR}" -`
const POLICY = { statusLine: { type: 'command', command: 'managed' } }

type Opts = { launcher?: boolean; surfaces?: string[]; policy?: boolean }

/** The engine beneath the mod, with the status line's file, surfaces and settings stubbed and every effect recorded. */
function world(on: On, opts: Opts = {}, entries: Record<string, unknown> = {}, env: Record<string, string> = { CLAUDE_CONFIG_DIR: '/cfg', HOME: '/h' }) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, entries)
  mock.env(on, env)
  const shown = {
    status: [] as (string | undefined)[],
    writes: [] as { path: string; text: string }[],
    removed: [] as string[][],
    config: [] as { key: string; value: unknown }[],
  }
  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'session-a' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5' }))
  on('session.surfaces', () => ({ value: opts.surfaces ?? ['terminal'] }))
  on('settings.read', (_, e) => {
    if (e.source === 'policy') return { value: opts.policy ? POLICY : {} }
    return { value: opts.launcher ? { statusLine: { type: 'command', command: LAUNCHER } } : {} }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nudgewhen__${e.name}` } }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'rm') shown.removed.push([...e.argv])
    return { value: { exitCode: 0, stdout: '|   "HIDIdleTime" = 1000000000\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', (_, e) => {
    shown.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('ui.status', (_, e) => {
    shown.status.push(e.text)
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
  return $.command.run({ command: 'nudge', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
}

const start = async ($: Engine, clock: { settle: () => Promise<unknown> }) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

const OPTS = { options: { status_segments: 'breaks,dir' } }
const PATH = '/cfg/nudgewhen/status/session-a.txt'

test('/nudge status accepts the launcher names', async ($, on) => {
  const { shown } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  expect((await nudge($, 'status sit,effort,dir')).text).toBe('Status line is now: sit,effort,dir.')
  expect(shown.config).toEqual([{ key: 'nudgewhen.status_segments', value: 'sit,effort,dir' }])
})

test('with the launcher on a terminal the mod writes its segments to the session file', OPTS, async ($, on) => {
  const { clock, shown } = world(on, { launcher: true })
  await start($, clock)
  expect(shown.writes).toEqual([{ path: PATH, text: `v1 ${NOW}\nbreaks,dir\nbreaks\tbreaks 0\n` }])
})

test('an empty CLAUDE_CONFIG_DIR falls back to HOME', OPTS, async ($, on) => {
  const { clock, shown } = world(on, { launcher: true }, {}, { CLAUDE_CONFIG_DIR: '', HOME: '/h' })
  await start($, clock)
  expect(shown.writes.map(w => w.path)).toEqual(['/h/.claude/nudgewhen/status/session-a.txt'])
})

test('with the launcher on a terminal ui.status never gets text', OPTS, async ($, on) => {
  const { clock, shown } = world(on, { launcher: true })
  await start($, clock)
  await clock.advance(30_000)
  expect(shown.status.filter(t => t !== undefined)).toEqual([])
})

test('off a terminal ui.status still shows', OPTS, async ($, on) => {
  const { clock, shown } = world(on, { launcher: true, surfaces: ['desktop'] })
  await start($, clock)
  expect(shown.status.at(-1)).toBe('breaks 0')
})

test('with no launcher ui.status shows and nothing is written', OPTS, async ($, on) => {
  const { clock, shown } = world(on)
  await start($, clock)
  expect(shown.status.at(-1)).toBe('breaks 0')
  expect(shown.writes).toEqual([])
})

test('the file is rewritten at 60 s, or at once when the list changes', OPTS, async ($, on) => {
  const { clock, shown } = world(on, { launcher: true })
  await start($, clock)
  await clock.advance(15_000)
  expect(shown.writes.length).toBe(1)
  await clock.advance(45_000)
  expect(shown.writes.length).toBe(2)
  expect(shown.writes[1]?.text.startsWith(`v1 ${NOW + 60_000}\n`)).toBe(true)
  await nudge($, 'status breaks,dir,cost')
  await clock.advance(15_000)
  expect(shown.writes.length).toBe(3)
  expect(shown.writes[2]?.text).toBe(`v1 ${NOW + 75_000}\nbreaks,dir,cost\nbreaks\tbreaks 0\n`)
})

test('session.end removes the session file', OPTS, async ($, on) => {
  const { clock, shown } = world(on, { launcher: true })
  await start($, clock)
  await $.session.end({ reason: 'exit' })
  expect(shown.removed).toEqual([['rm', '-f', PATH]])
})

test('/nudge statusline wrap, only and off write status_line; anything else is usage', async ($, on) => {
  const { shown } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  for (const v of ['wrap', 'only', 'off']) await nudge($, `statusline ${v}`)
  expect(shown.config).toEqual([
    { key: 'nudgewhen.status_line', value: 'wrap' },
    { key: 'nudgewhen.status_line', value: 'only' },
    { key: 'nudgewhen.status_line', value: 'off' },
  ])
  shown.config.length = 0
  expect((await nudge($, 'statusline bogus')).text).toMatch(/Usage: \/nudge statusline/)
  expect(shown.config).toEqual([])
})

test('/nudge statusline says the launcher is carried', async ($, on) => {
  const { shown } = world(on, { launcher: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  expect((await nudge($, 'statusline')).text).toMatch(/carried/)
  expect(shown.config).toEqual([])
})

test('/nudge statusline under a managed policy names the guard', async ($, on) => {
  world(on, { policy: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  expect((await nudge($, 'statusline')).text).toMatch(/managed policy/)
})
