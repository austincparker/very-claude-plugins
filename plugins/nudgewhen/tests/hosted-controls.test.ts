import type { McpConnectResult, McpToolResult, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { hostedText, parseHostedStatus, parsePrefs, prefsLines } from '../hooks/hosted'
import { MINUTE } from '../hooks/schedule'
import { paidText, setHosted } from '../hooks/status'

const SERVER = 'plugin:nudgewhen:nudgewhen'
const NOW = new Date(2026, 10, 10, 12, 0, 0, 0).getTime()
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

const text = (body: unknown, isError = false): McpToolResult => ({
  content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
  isError,
})
const connected: McpConnectResult = { isConnected: true, server: SERVER }
const needsAuth: McpConnectResult = {
  isConnected: false,
  reason: 'auth',
  message: 'The MCP server needs you to sign in; run /mcp to authenticate.',
}

type Prefs = {
  kinds: string[]
  muted_repos: string[]
  failures_only: boolean
  quiet: string
  tz: string
  paused_until: number | null
}
const PREFS: Prefs = {
  kinds: ['ci', 'review_requested', 'review_submitted', 'pr_landed'],
  muted_repos: ['acme/noisy'],
  failures_only: false,
  quiet: '',
  tz: 'UTC',
  paused_until: null,
}
const STATUS = {
  pending: 2,
  next_due: NOW + 60_000,
  paused_until: null as number | null,
  quiet_now: false,
  kinds: PREFS.kinds,
  muted_repos: 1,
  last_ci: { text: 'acme/app CI failed', at: NOW - 1000 } as { text: string; at: number } | null,
  last_review: { text: 'octo asked for your review', at: NOW - 2000 } as { text: string; at: number } | null,
}

/** The engine beneath the mod, with the hosted server holding `prefs` and answering `status`. */
function world(on: On, opts: { connect?: McpConnectResult; prefs?: Prefs; status?: unknown; setError?: boolean; getError?: boolean } = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {})
  const calls = { status: 0, get: 0, set: [] as Record<string, unknown>[], config: [] as { key: string; value: unknown }[] }
  const server = { prefs: { ...(opts.prefs ?? PREFS) }, status: opts.status ?? STATUS }
  const shown = { status: undefined as string | undefined }
  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nudgewhen__${e.name}` } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '|   "HIDIdleTime" = 1000000000\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('ui.status', (_, e) => {
    shown.status = e.text
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
  on('config.set', (_, e) => {
    calls.config.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('mcp.connect', () => ({ value: opts.connect ?? connected }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'poll_nudges') return { value: text({ nudges: [] }) }
    if (e.tool === 'hosted_status') {
      calls.status += 1
      return { value: text(server.status) }
    }
    if (e.tool === 'get_prefs') {
      calls.get += 1
      if (opts.getError) return { value: text('down', true) }
      return { value: text(server.prefs) }
    }
    if (e.tool === 'set_prefs') {
      calls.set.push(e.args)
      if (opts.setError) return { value: text('invalid', true) }
      server.prefs = { ...server.prefs, ...e.args }
      return { value: text(server.prefs) }
    }
    return { value: text({}) }
  })
  return { clock, calls, shown, server }
}

function nudge($: Engine, args: string) {
  return $.command.run({
    command: 'nudge',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const run = async ($: Engine, args: string) => (await nudge($, args)).text

test('parseHostedStatus reads the server shape and rejects anything else', () => {
  expect(parseHostedStatus(text(STATUS))).toEqual(STATUS)
  expect(parseHostedStatus(text({ ...STATUS, pending: 'two' }))).toBeNull()
  expect(parseHostedStatus(text({ ...STATUS, last_ci: 5 }))).toBeNull()
  expect(parseHostedStatus(text('not json'))).toBeNull()
  expect(parseHostedStatus(text(STATUS, true))).toBeNull()
  expect(parseHostedStatus({ content: [], isError: false })).toBeNull()
})

test('parsePrefs reads the server shape and rejects anything else', () => {
  expect(parsePrefs(text(PREFS))).toEqual(PREFS)
  expect(parsePrefs(text({ ...PREFS, kinds: 'ci' }))).toBeNull()
  expect(parsePrefs(text({ ...PREFS, muted_repos: [1] }))).toBeNull()
  expect(parsePrefs(text(PREFS, true))).toBeNull()
})

test('while connected, hosted_status is called at once and then every 5 minutes', async ($, on) => {
  const { clock, calls } = world(on)
  await start($)
  await clock.settle()
  await clock.advance(30_000)
  expect(calls.status).toBe(1)
  await clock.advance(4 * MINUTE)
  expect(calls.status).toBe(1)
  await clock.advance(MINUTE)
  expect(calls.status).toBe(2)
  await clock.advance(5 * MINUTE)
  expect(calls.status).toBe(3)
})

test('hosted_status is never called when the server needs a sign-in', async ($, on) => {
  const { clock, calls, shown } = world(on, { connect: needsAuth })
  await start($)
  await clock.settle()
  await clock.advance(11 * MINUTE)
  expect(calls.status).toBe(0)
  expect(shown.status).toBe(undefined)
})

test('the hosted, ci and reviews segments show what the server reported', { options: { status_segments: 'hosted,ci,reviews' } }, async ($, on) => {
  const { clock, shown } = world(on)
  await start($)
  await clock.settle()
  await clock.advance(30_000)
  expect(shown.status).toBe('hosted 2 pending  ·  acme/app CI failed  ·  octo asked for your review')
})

test('the hosted segment says paused, then quiet, ahead of the pending count', { options: { status_segments: 'hosted' } }, async ($, on) => {
  const paused = world(on, { status: { ...STATUS, paused_until: NOW + 99_999 } })
  await start($)
  await paused.clock.settle()
  await paused.clock.advance(30_000)
  expect(paused.shown.status).toBe('hosted paused')
})

test('quiet_now shows hosted quiet; an empty queue shows hosted ok', { options: { status_segments: 'hosted,ci' } }, async ($, on) => {
  const { clock, shown } = world(on, { status: { ...STATUS, pending: 0, quiet_now: true, last_ci: null } })
  await start($)
  await clock.settle()
  await clock.advance(30_000)
  expect(shown.status).toBe('hosted quiet')
})

test('a server-sent status is cleaned before it reaches the terminal', { options: { status_segments: 'ci' } }, async ($, on) => {
  const evil = { ...STATUS, last_ci: { text: 'bad\x1b[31m\nnews', at: NOW } }
  const { clock, shown } = world(on, { status: evil })
  await start($)
  await clock.settle()
  await clock.advance(30_000)
  expect(shown.status).not.toMatch(/[\u0000-\u001f\u007f]/)
})

test('paidText is blank until a status has arrived', () => {
  setHosted(undefined)
  expect(paidText('hosted', NOW)).toBe('')
  expect(paidText('ci', NOW)).toBe('')
  expect(paidText('reviews', NOW)).toBe('')
})

test('a status that leaves out last_ci or last_review still reads', () => {
  const { last_ci: _ci, last_review: _review, ...rest } = STATUS
  expect(parseHostedStatus(text(rest))).toEqual({ ...rest, last_ci: null, last_review: null })
})

test('hostedText: an expired pause is not shown, and paused beats quiet beats pending', () => {
  const s = parseHostedStatus(text(STATUS))!
  expect(hostedText(undefined, NOW)).toBe('')
  expect(hostedText(s, NOW)).toBe('hosted 2 pending')
  expect(hostedText({ ...s, pending: 0 }, NOW)).toBe('hosted ok')
  expect(hostedText({ ...s, quiet_now: true }, NOW)).toBe('hosted quiet')
  expect(hostedText({ ...s, quiet_now: true, paused_until: NOW + 1 }, NOW)).toBe('hosted paused')
  expect(hostedText({ ...s, paused_until: NOW }, NOW)).toBe('hosted 2 pending')
  expect(hostedText({ ...s, paused_until: NOW - 1, pending: 0 }, NOW)).toBe('hosted ok')
})

test('prefs from the server are cleaned and kept within the limits', () => {
  const evil = { ...PREFS, muted_repos: ['a/b\x1b[31m\nforged'], tz: 'x\u202ey' }
  const lines = prefsLines(parsePrefs(text(evil))!, NOW)
  expect(lines).toContain('  muted repos: a/b [31m forged')
  expect(lines.join('\n')).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u202e]/)
  const many = Array.from({ length: 150 }, (_, i) => `a/r${i}`)
  expect(parsePrefs(text({ ...PREFS, muted_repos: many }))!.muted_repos.length).toBe(100)
})

test('a failing hosted_status clears the paid segments', { options: { status_segments: 'hosted,ci' } }, async ($, on) => {
  const { clock, shown, server } = world(on)
  await start($)
  await clock.settle()
  await clock.advance(30_000)
  expect(shown.status).toBe('hosted 2 pending  ·  acme/app CI failed')
  server.status = 'not json'
  await clock.advance(5 * MINUTE + 30_000)
  expect(shown.status).toBeUndefined()
})

test('/nudge prefs shows the server preferences', async ($, on) => {
  const { clock } = world(on, { prefs: { ...PREFS, failures_only: true, quiet: '22:00-07:00', tz: 'Europe/London' } })
  await start($)
  await clock.settle()
  const r = await run($, 'prefs')
  expect(r).toMatch(/kinds.*ci.*review_requested.*review_submitted.*pr_landed/)
  expect(r).toMatch(/muted.*acme\/noisy/)
  expect(r).toMatch(/failures.only.*on/i)
  expect(r).toMatch(/22:00-07:00.*Europe\/London/)
})

test('/nudge mute adds a repo to the muted list, lowercased, keeping the rest', async ($, on) => {
  const { clock, calls } = world(on)
  await start($)
  await clock.settle()
  expect(await run($, 'mute Acme/Web')).toMatch(/acme\/web/)
  expect(calls.set).toEqual([{ muted_repos: ['acme/noisy', 'acme/web'] }])
  expect(await run($, 'mute acme/WEB')).toMatch(/already/i)
  expect(calls.set.length).toBe(1)
})

test('/nudge unmute removes a repo and says so when it was not muted', async ($, on) => {
  const { clock, calls } = world(on)
  await start($)
  await clock.settle()
  expect(await run($, 'unmute ACME/noisy')).toMatch(/acme\/noisy/)
  expect(calls.set).toEqual([{ muted_repos: [] }])
  expect(await run($, 'unmute acme/noisy')).toMatch(/not muted/i)
  expect(calls.set.length).toBe(1)
})

test('mute and unmute want owner/repo and call nothing otherwise', async ($, on) => {
  const { clock, calls } = world(on)
  await start($)
  await clock.settle()
  for (const arg of ['mute', 'mute web', 'mute a/b/c', 'unmute', 'unmute web']) {
    expect(await run($, arg)).toMatch(/Usage: \/nudge (mute|unmute) owner\/repo/)
  }
  expect(calls.set).toEqual([])
})

test('/nudge failures-only on and off', async ($, on) => {
  const { clock, calls } = world(on)
  await start($)
  await clock.settle()
  expect(await run($, 'failures-only on')).toMatch(/on/)
  expect(await run($, 'failures-only off')).toMatch(/off/)
  expect(calls.set).toEqual([{ failures_only: true }, { failures_only: false }])
  expect(await run($, 'failures-only maybe')).toMatch(/Usage: \/nudge failures-only on\|off/)
  expect(calls.set.length).toBe(2)
})

test('/nudge kinds sets the kinds list and refuses a name the server would', async ($, on) => {
  const { clock, calls } = world(on)
  await start($)
  await clock.settle()
  expect(await run($, 'kinds ci, pr_landed')).toMatch(/ci, pr_landed/)
  expect(calls.set).toEqual([{ kinds: ['ci', 'pr_landed'] }])
  const bad = await run($, 'kinds ci,bogus')
  expect(bad).toMatch(/bogus/)
  expect(bad).toMatch(/review_requested/)
  expect(await run($, 'kinds')).toMatch(/Usage: \/nudge kinds/)
  expect(calls.set.length).toBe(1)
})

test('with the server not signed in, each hosted control answers one sign-in line and calls nothing', async ($, on) => {
  const { clock, calls } = world(on, { connect: needsAuth })
  await start($)
  await clock.settle()
  for (const arg of ['prefs', 'mute a/b', 'unmute a/b', 'failures-only on', 'kinds ci']) {
    const r = await run($, arg)
    expect(r.split('\n').length).toBe(1)
    expect(r).toMatch(/\/mcp/)
  }
  expect(calls.get).toBe(0)
  expect(calls.set).toEqual([])
})

test('a refused set_prefs is reported, not swallowed', async ($, on) => {
  const { clock } = world(on, { setError: true })
  await start($)
  await clock.settle()
  expect(await run($, 'failures-only on')).toMatch(/could not|refused|failed/i)
})

test('quiet hours go to the server with the local zone, and clearing sends an empty range', async ($, on) => {
  const { clock, calls } = world(on)
  await start($)
  await clock.settle()
  expect(await run($, 'quiet 22:00-07:00')).toBe('Quiet hours are now 22:00-07:00.')
  expect(calls.set).toEqual([{ quiet: '22:00-07:00', tz: ZONE }])
  expect(await run($, 'quiet')).toBe('Quiet hours cleared.')
  expect(calls.set[1]).toEqual({ quiet: '', tz: ZONE })
})

test('quiet hours still save locally when the server is not signed in', async ($, on) => {
  const { clock, calls } = world(on, { connect: needsAuth })
  await start($)
  await clock.settle()
  expect(await run($, 'quiet 22:00-07:00')).toBe('Quiet hours are now 22:00-07:00.')
  expect(calls.config).toEqual([{ key: 'nudgewhen.quiet_hours', value: '22:00-07:00' }])
  expect(calls.set).toEqual([])
})

test('pause and resume keep the local answer when signed out', async ($, on) => {
  const { clock, calls } = world(on, { connect: needsAuth })
  await start($)
  await clock.settle()
  expect(await run($, 'pause')).toBe('Paused until /nudge resume.')
  expect(await run($, 'resume')).toBe('Resumed. Nudges are on.')
  expect(await run($, 'resume')).toBe('Nothing was paused.')
  expect(calls.set).toEqual([])
})

test('a server failure on pause adds one line to the local answer', async ($, on) => {
  const { clock } = world(on, { setError: true })
  await start($)
  await clock.settle()
  const r = (await run($, 'pause until 14:30')).split('\n')
  expect(r[0]).toBe('Paused until 14:30.')
  expect(r.length).toBe(2)
})

test('a snooze is sent to the hosted server as a pause', async ($, on) => {
  const { clock, calls } = world(on)
  await start($)
  await clock.settle()
  await run($, 'snooze 30m')
  expect(calls.set[0]).toEqual({ paused_until: NOW + 30 * MINUTE, tz: ZONE })
})

test('mute needs the prefs to read, a valid repo, and room in the list', async ($, on) => {
  const down = world(on, { getError: true })
  await start($)
  await down.clock.settle()
  expect(await run($, 'mute acme/web')).toBe('Could not reach your hosted preferences. Try again.')
  expect(down.calls.set).toEqual([])
})

test('mute refuses a bad repo and a full list', async ($, on) => {
  const full = Array.from({ length: 100 }, (_, i) => `a/r${i}`)
  const { clock, calls } = world(on, { prefs: { ...PREFS, muted_repos: full } })
  await start($)
  await clock.settle()
  expect(await run($, 'mute notarepo')).toMatch(/Usage/)
  expect(await run($, `mute ${'a'.repeat(100)}/${'b'.repeat(100)}`)).toMatch(/Usage/)
  expect(await run($, 'mute acme/web')).toMatch(/already mute 100/)
  expect(calls.set).toEqual([])
})

test('a bad quiet range sends nothing to the server', async ($, on) => {
  const { clock, calls } = world(on)
  await start($)
  await clock.settle()
  expect(await run($, 'quiet 5')).toMatch(/Usage/)
  expect(calls.set).toEqual([])
})

test('pause sends paused_until with the zone, and resume clears it', async ($, on) => {
  const { clock, calls } = world(on)
  await start($)
  await clock.settle()
  const at = new Date(2026, 10, 10, 14, 30, 0, 0).getTime()
  await run($, 'pause until 14:30')
  expect(calls.set[0]).toEqual({ paused_until: at, tz: ZONE })
  await run($, 'resume')
  expect(calls.set[1]).toEqual({ paused_until: null, tz: ZONE })
})

test('a pause with no end sends a far-future paused_until', async ($, on) => {
  const { clock, calls } = world(on)
  await start($)
  await clock.settle()
  await run($, 'pause')
  expect(typeof calls.set[0]?.paused_until).toBe('number')
  expect(calls.set[0]!.paused_until as number).toBeGreaterThan(NOW + 365 * 24 * 60 * MINUTE)
})

test('a server failure on quiet or pause leaves the local answer and adds one line', async ($, on) => {
  const { clock } = world(on, { setError: true })
  await start($)
  await clock.settle()
  const r = await run($, 'quiet 22:00-07:00')
  expect(r.split('\n')[0]).toBe('Quiet hours are now 22:00-07:00.')
  expect(r.split('\n').length).toBe(2)
})

test('/nudge help lists the hosted controls', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.settle()
  const r = await run($, 'help')
  for (const word of ['prefs', 'mute', 'unmute', 'failures-only', 'kinds']) expect(r).toContain(word)
})
