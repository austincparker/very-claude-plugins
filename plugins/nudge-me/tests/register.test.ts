import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MINUTE } from '../hooks/schedule'

const TOOL = 'mcp__nudge-me__nudge'

/** Stands for the engine beneath the mod: a machine idle for `idleMs`, and a record of what the mod showed. */
function world(on: On, now: number, entries: Record<string, unknown> = {}, idleMs = 1000) {
  const clock = mock.clock(on, { now })
  mock.store(on, entries)
  const shown = { toasts: [] as string[], notified: [] as string[], status: undefined as string | undefined }
  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nudge-me__${e.name}` } }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: `|   "HIDIdleTime" = ${idleMs * 1e6}\n`,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
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

function localAt(hour: number, minute = 0): number {
  return new Date(2026, 10, 10, hour, minute, 0, 0).getTime()
}

test('/nudge sets a nudge that fires on time, then lists empty', async ($, on) => {
  const { clock, shown } = world(on, localAt(12))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const set = await nudge($, 'in 1m stretch')
  expect(set.text).toBe('Nudge #1 set for 12:01 (in 1m): stretch')

  await clock.advance(45_000)
  expect(shown.toasts).toEqual([])
  await clock.advance(30_000)
  expect(shown.toasts).toEqual(['nudge: stretch'])
  expect(shown.notified).toEqual(['stretch'])
  expect(shown.status).toBe('nudge: stretch')

  const list = await nudge($, 'list')
  expect(list.text).toMatch(/^No nudges set/)

  await clock.advance(11 * MINUTE)
  expect(shown.status).toBe(undefined)
})

test('/nudge cancels by id and refuses an unknown one', async ($, on) => {
  world(on, localAt(12))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })

  await nudge($, 'every 45m drink water')
  await nudge($, 'at 17:30 wrap up')
  const list = await nudge($, '')
  expect(list.text).toMatch(/#1 {2}every 45m, next 12:45 {2}drink water/)
  expect(list.text).toMatch(/#2 {2}17:30 \(in 5h 30m\) {2}wrap up/)

  expect((await nudge($, 'cancel #1')).text).toBe('Cancelled #1: drink water')
  expect((await nudge($, 'cancel 9')).text).toMatch(/^No nudge #9/)
  expect((await nudge($, 'cancel all')).text).toBe('Cancelled 1 nudge.')
})

test('ids keep counting after the nudges are gone', async ($, on) => {
  world(on, localAt(12), { nextId: 7 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  expect((await nudge($, 'in 5m tea')).text).toMatch(/^Nudge #8 /)
})

test('the model sets and lists nudges through the tool', async ($, on) => {
  world(on, localAt(12))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })

  const set = await $.tool.call({ tool: TOOL, when: 'in 20m', text: 'check the deploy' })
  expect(set.result).toBe('Nudge #1 set for 12:20 (in 20m): check the deploy')

  const list = await $.tool.call({ tool: TOOL })
  expect(list.result).toMatch(/#1 {2}12:20 \(in 20m\) {2}check the deploy/)

  const cancel = await $.tool.call({ tool: TOOL, cancel: 'all' })
  expect(cancel.result).toBe('Cancelled 1 nudge.')
})

test('an agent launch after a long sit gets one break prompt per half hour', async ($, on) => {
  const now = localAt(12)
  const sit = { sitStart: now - 40 * MINUTE, awayStart: null, updated: now }
  const { clock, shown } = world(on, now, { sit })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' })
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' })
  expect(shown.toasts.length).toBe(1)
  expect(shown.toasts[0]).toMatch(/at the keyboard 40m/)

  await clock.advance(31 * MINUTE)
  await $.tool.call({ tool: 'Workflow', script: 'x' })
  expect(shown.toasts.length).toBe(2)
  expect(shown.toasts[1]).toMatch(/at the keyboard 71m/)
})

test('no break prompt once the sit reading goes stale', async ($, on) => {
  const now = localAt(12)
  const sit = { sitStart: now - 40 * MINUTE, awayStart: null, updated: now - 10 * MINUTE }
  const { shown } = world(on, now, { sit })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' })
  expect(shown.toasts).toEqual([])
})

test('the status line counts the sit and nudges at bedtime', async ($, on) => {
  const now = localAt(23, 30)
  const sit = { sitStart: now - 65 * MINUTE, awayStart: null, updated: now }
  const { clock, shown } = world(on, now, { sit })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(shown.status).toBe('sat 65m · stand up  ·  past 11pm · time to wrap up')
})

test('a long idle is a break: the sit count clears', async ($, on) => {
  const now = localAt(12)
  const sit = { sitStart: now - 50 * MINUTE, awayStart: null, updated: now - 15_000 }
  const { clock, shown } = world(on, now, { sit }, 6 * MINUTE)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(shown.status).toBe(undefined)
  const report = await nudge($, 'report')
  expect(report.text).toMatch(/2026-11-10\s+0\s+44m\s+44m/)
})
