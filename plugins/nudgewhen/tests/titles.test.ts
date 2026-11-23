import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { TITLE_JS, cleanTitle, isGhostty, parseTitleArgs, readTitlesOn, ttyPath, titleArgv } from '../hooks/titles'

const IOREG = '|   "HIDIdleTime" = 1000000000\n'

type Opts = { env?: Record<string, string>; entries?: Record<string, unknown>; tty?: string; osaFails?: boolean }

let clock: ReturnType<typeof mock.clock>

/** The engine beneath the mod, recording every process argv and every hosted call. */
function world(on: On, o: Opts = {}) {
  clock = mock.clock(on, { now: new Date(2026, 10, 10, 12).getTime() })
  const store = new Map<string, unknown>(Object.entries(o.entries ?? {}))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.end', () => ({ sessionId: 'session-a' }))
  mock.env(on, o.env ?? {})
  const seen = { store, argv: [] as string[][], mcp: [] as string[], config: [] as { key: string; value: unknown }[], toasts: [] as string[] }
  const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nudgewhen__${e.name}` } }))
  on('process.run', (_, e) => {
    const argv = e.argv as string[]
    seen.argv.push(argv)
    if (argv[0] === 'sh') return out(`${o.tty ?? 'ttys006'}\n`)
    if (argv[0] === 'osascript') return o.osaFails ? out('', 1) : out('')
    return out(IOREG)
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('config.set', (_, e) => {
    seen.config.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:nudgewhen:nudgewhen' } }))
  on('mcp.call', (_, e) => {
    seen.mcp.push(JSON.stringify(e))
    return { value: { content: [{ type: 'text', text: '{"nudges":[]}' }], isError: false } }
  })
  return seen
}

const nudge = ($: Engine, args: string) =>
  $.command.run({ command: 'nudge', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

/** Starts the session and lets its first tick finish, so no hosted poll outlives the test. */
async function start($: Engine, isInteractive = true) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive })
  await clock.settle()
}
const osa = (s: { argv: string[][] }) => s.argv.filter(a => a[0] === 'osascript')
const GHOSTTY = { TERM_PROGRAM: 'ghostty' }
const ROLE_ENV = { ...GHOSTTY, NUDGEWHEN_ROLE: 'Dispatcher', NUDGEWHEN_SET: 'nudge-set' }

test('cleanTitle strips control characters, trims and caps at 60', () => {
  expect(cleanTitle('  Dis\u001b[patcher\u0007  ')).toBe('Dis[patcher')
  expect(cleanTitle('a\nb')).toBe('ab')
  expect(cleanTitle('x'.repeat(80))).toBe('x'.repeat(60))
  expect(cleanTitle('\u0001 \u0002')).toBe('')
})

test('titles are off only when the value is exactly off', () => {
  for (const v of ['off', 'Off', ' off ', 'no', 'false', '0', false]) expect(readTitlesOn(v)).toBe(false)
  for (const v of [undefined, '', 'on', 'ON', true]) expect(readTitlesOn(v)).toBe(true)
})

test('parseTitleArgs reads each verb and returns usage for the rest', () => {
  expect(parseTitleArgs('')).toEqual({ show: true })
  expect(parseTitleArgs('role Ship')).toEqual({ role: 'Ship' })
  expect(parseTitleArgs('ROLE  House seat ')).toEqual({ role: 'House seat' })
  expect(parseTitleArgs('set nudgewhen')).toEqual({ set: 'nudgewhen' })
  expect(parseTitleArgs('clear')).toEqual({ clear: true })
  expect(parseTitleArgs('on')).toEqual({ on: true })
  expect(parseTitleArgs('off')).toEqual({ off: true })
  for (const bad of ['role', 'role   ', 'set', 'role \u0001', 'dance', 'clear now', 'on off']) {
    expect(typeof parseTitleArgs(bad)).toBe('string')
    expect(parseTitleArgs(bad)).toMatch(/Usage: \/nudge title/)
  }
})

test('only ghostty is Ghostty', () => {
  expect(isGhostty('ghostty')).toBe(true)
  for (const v of [undefined, '', 'Ghostty', 'iTerm.app', 'Apple_Terminal', 'ghostty2']) expect(isGhostty(v)).toBe(false)
})

test('ttyPath makes a device path from ps output and refuses everything else', () => {
  expect(ttyPath('ttys006\n')).toBe('/dev/ttys006')
  expect(ttyPath('  ttys012  ')).toBe('/dev/ttys012')
  for (const v of ['??', '??\n', '', '   ', IOREG, 'ttys006 extra', '../../etc/passwd', 'pts/3', null, undefined]) expect(ttyPath(v as string)).toBeNull()
})

test('argv passes the values as arguments and never inside the script', () => {
  const argv = titleArgv('/dev/ttys006', 'Evil"; quit', "it's")
  expect(argv.slice(0, 4)).toEqual(['osascript', '-l', 'JavaScript', '-e'])
  expect(argv[4]).toBe(TITLE_JS)
  expect(argv.slice(5)).toEqual(['/dev/ttys006', 'Evil"; quit', "it's"])
  expect(TITLE_JS).not.toContain('Evil')
  expect(TITLE_JS).toContain('Ghostty')
  expect(TITLE_JS).toContain('nameOverride')
})

test('a Ghostty session start sets the tab and window titles once', async ($, on) => {
  const seen = world(on, { env: ROLE_ENV })
  await start($)
  expect(osa(seen).length).toBe(1)
  expect(osa(seen)[0]!.slice(-3)).toEqual(['/dev/ttys006', 'Dispatcher', 'nudge-set'])
})

test('no role and no set runs no osascript', async ($, on) => {
  const seen = world(on, { env: GHOSTTY })
  await start($)
  expect(osa(seen)).toEqual([])
})

test('outside Ghostty nothing runs', async ($, on) => {
  const seen = world(on, { env: { TERM_PROGRAM: 'iTerm.app', NUDGEWHEN_ROLE: 'Dispatcher' } })
  await start($)
  expect(osa(seen)).toEqual([])
  expect(seen.argv.some(a => a[0] === 'sh')).toBe(false)
})

test('a headless session runs nothing', async ($, on) => {
  const seen = world(on, { env: ROLE_ENV })
  await start($, false)
  expect(osa(seen)).toEqual([])
})

test('a tty of ?? runs nothing', async ($, on) => {
  const seen = world(on, { env: ROLE_ENV, tty: '??' })
  await start($)
  expect(osa(seen)).toEqual([])
})

test('/nudge title role applies the title, replies and stores it', async ($, on) => {
  const seen = world(on, { env: GHOSTTY })
  await start($)
  expect((await nudge($, 'title role Ship')).text).toBe('Tab title is now Ship.')
  expect(osa(seen).map(a => a.slice(-3))).toEqual([['/dev/ttys006', 'Ship', '']])
  expect(seen.store.get('titles')).toEqual({ 'session-a': { role: 'Ship', set: '' } })
})

test('/nudge title set names the window', async ($, on) => {
  const seen = world(on, { env: GHOSTTY })
  await start($)
  expect((await nudge($, 'title set very-claude')).text).toBe('Window title is now very-claude.')
  expect(osa(seen).map(a => a.slice(-3))).toEqual([['/dev/ttys006', '', 'very-claude']])
  expect(seen.store.get('titles')).toEqual({ 'session-a': { role: '', set: 'very-claude' } })
})

test('the stored role beats the env at the next start', async ($, on) => {
  const seen = world(on, { env: ROLE_ENV, entries: { titles: { 'session-a': { role: 'Ship', set: '' } } } })
  await start($)
  expect(osa(seen).map(a => a.slice(-3))).toEqual([['/dev/ttys006', 'Ship', 'nudge-set']])
})

test('stored titles are cleaned before they reach osascript', async ($, on) => {
  const seen = world(on, { env: GHOSTTY, entries: { titles: { 'session-a': { role: 'Sh\u001bip', set: 'x'.repeat(80) } } } })
  await start($)
  expect(osa(seen).map(a => a.slice(-3))).toEqual([['/dev/ttys006', 'Ship', 'x'.repeat(60)]])
})

test('after clear the env titles do not come back', async ($, on) => {
  const seen = world(on, { env: ROLE_ENV })
  await start($)
  await nudge($, 'title clear')
  seen.argv.length = 0
  expect((await nudge($, 'title')).text).toContain('Tab title: (none)')
  await start($)
  expect(osa(seen)).toEqual([])
})

test('after clear, setting one title leaves the other empty despite the env', async ($, on) => {
  const seen = world(on, { env: ROLE_ENV })
  await start($)
  await nudge($, 'title clear')
  seen.argv.length = 0
  await nudge($, 'title set ship')
  expect(osa(seen).map(a => a.slice(-3))).toEqual([['/dev/ttys006', '', 'ship']])
  expect((await nudge($, 'title')).text).toContain('Tab title: (none). Window title: ship.')
  seen.argv.length = 0
  await start($)
  expect(osa(seen).map(a => a.slice(-3))).toEqual([['/dev/ttys006', '', 'ship']])
})

test('off stops the titles and on brings them back', async ($, on) => {
  const seen = world(on, { env: ROLE_ENV })
  expect((await nudge($, 'title off')).text).toBe('Titles are now off.')
  expect(seen.config).toEqual([{ key: 'nudgewhen.titles', value: 'off' }])
  await start($)
  expect(osa(seen)).toEqual([])
  expect((await nudge($, 'title on')).text).toBe('Titles are now on.')
  expect(seen.config[1]).toEqual({ key: 'nudgewhen.titles', value: 'on' })
  await start($)
  expect(osa(seen).length).toBe(1)
})

test('titles configured off run nothing', { options: { titles: 'off' } }, async ($, on) => {
  const seen = world(on, { env: ROLE_ENV })
  await start($)
  expect(osa(seen)).toEqual([])
})

test('clear empties both titles and stops the env fallback', async ($, on) => {
  const seen = world(on, { env: GHOSTTY, entries: { titles: { 'session-a': { role: 'Ship', set: 'x' }, 'session-b': { role: 'Y', set: '' } } } })
  await start($)
  seen.argv.length = 0
  await nudge($, 'title clear')
  expect(osa(seen).map(a => a.slice(-3))).toEqual([['/dev/ttys006', '', '']])
  expect(seen.store.get('titles')).toEqual({ 'session-b': { role: 'Y', set: '' }, 'session-a': { role: '', set: '', cleared: true } })
})

test('a failing osascript is silent at start and reported by the command', async ($, on) => {
  const seen = world(on, { env: ROLE_ENV, osaFails: true })
  await start($)
  expect(seen.toasts).toEqual([])
  const r = await nudge($, 'title role Ship')
  expect(r.text).toMatch(/could not be set/)
})

test('bare /nudge title shows the values and a bad verb shows usage', async ($, on) => {
  world(on, { env: ROLE_ENV })
  await start($)
  const shown = (await nudge($, 'title')).text
  expect(shown).toContain('Dispatcher')
  expect(shown).toContain('nudge-set')
  expect((await nudge($, 'title dance')).text).toMatch(/Usage: \/nudge title/)
})

test('session end leaves the titles alone', async ($, on) => {
  const seen = world(on, { env: ROLE_ENV })
  await start($)
  const before = seen.argv.length
  await $.session.end({ sessionId: 'session-a', reason: 'other', resume: { id: 'session-a' } })
  expect(seen.argv.length).toBe(before)
})

test('titles make no hosted call', async ($, on) => {
  const seen = world(on, { env: ROLE_ENV })
  await start($)
  await nudge($, 'title role Ship')
  await nudge($, 'title clear')
  const args = seen.mcp.map(m => JSON.stringify((JSON.parse(m) as { args?: unknown }).args ?? null)).join('')
  expect(args).not.toMatch(/Ship|Dispatcher|nudge-set/)
})
