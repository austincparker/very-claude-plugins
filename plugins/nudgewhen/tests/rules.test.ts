import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { pickLine } from '../hooks/lines'
import { countNeverLines, countSettings } from '../hooks/rules'
import { MINUTE } from '../hooks/schedule'

const HOME = '/home/u'
const CWD = '/work/app'
const TICK = 15_000
const USER = `${HOME}/.claude/settings.json`
const PROJECT = `${CWD}/.claude/settings.json`
const LOCAL = `${CWD}/.claude/settings.local.json`
const USER_MD = `${HOME}/.claude/CLAUDE.md`

type Disk = { settings: Record<string, unknown>; files: Record<string, string>; unreadable: Set<string> }

/** An engine with a settings store and files the test edits between ticks. */
function world(on: On, now: number) {
  const clock = mock.clock(on, { now })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : e.name === 'NUDGEWHEN_DICE' ? String(diceValue) : undefined }))
  const disk: Disk = { settings: {}, files: {}, unreadable: new Set() }
  const store = new Map<string, unknown>()
  const shown = { toasts: [] as string[], logs: [] as string[] }
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nudgewhen__${e.name}` } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '|   "HIDIdleTime" = 1000000000\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('settings.read', (_, e) => {
    const path = e.source === 'user' ? USER : e.source === 'project' ? PROJECT : LOCAL
    if (disk.unreadable.has(path)) throw new Error('unreadable')
    return { value: (disk.settings[path] ?? {}) as Record<string, unknown> }
  })
  on('fs.exists', (_, e) => ({ value: e.path in disk.files || Object.keys(disk.files).some(p => p.startsWith(`${e.path}/`)) }))
  on('fs.read', (_, e) => {
    if (disk.unreadable.has(e.path)) throw new Error('unreadable')
    return { value: disk.files[e.path] ?? '' }
  })
  on('fs.list', (_, e) => ({
    value: Object.keys(disk.files)
      .filter(p => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/'))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file', size: 1, isLink: false, mtimeMs: 0 })),
  }))
  on('ui.toast', (_, e) => {
    shown.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', (_, e) => {
    shown.logs.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: {} }))
  return { clock, disk, store, shown }
}

const start = async ($: Engine) => {
  roll(0.3)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
}
const deny = (n: number) => ({ permissions: { deny: Array.from({ length: n }, (_, i) => `Bash(rm ${i})`) } })
const noon = new Date(2026, 10, 10, 12, 0, 0, 0).getTime()
const VULGAR = { options: { tone: 'vulgar' } }
// 0.3 wins the one-in-three rules roll and loses the one-in-four fat-lard draw.
let diceValue = 0.5
const roll = (v: number) => {
  diceValue = v
}
const PREFIX = 'Quit being such a bitch: '

test('counts: settings entries and instruction lines', () => {
  expect(countSettings({ permissions: { deny: ['a', 'b'], ask: ['c'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }, { type: 'command', command: 'y' }] }, { hooks: [{ type: 'prompt' }] }] } })).toEqual({ deny: 2, ask: 1, hooks: 2 })
  expect(countSettings(undefined)).toEqual({ deny: 0, ask: 0, hooks: 0 })
  expect(countNeverLines("Never push\nbe nice\nDo not amend\nit's fine (HARD)\nneverland\nOff limits: x\nDON'T")).toBe(5)
})

test('first sight records a baseline with no toast', VULGAR, async ($, on) => {
  const { clock, disk, store, shown } = world(on, noon)
  disk.settings[USER] = deny(3)
  disk.files[USER_MD] = 'Never do it\n'
  await start($)
  await clock.settle()
  expect(shown.toasts).toEqual([])
  expect(store.get('rules')).toMatchObject({ [USER]: { deny: 3, ask: 0, hooks: 0 }, [USER_MD]: { never: 1 } })
})

const GROWTH: [string, string, (d: Disk) => void, string][] = [
  ['deny', USER, d => (d.settings[USER] = deny(3)), '2 new deny rules in ~/.claude/settings.json'],
  ['ask', LOCAL, d => (d.settings[LOCAL] = { permissions: { ask: ['Bash(git push)'] } }), 'a new ask rule in .claude/settings.local.json'],
  ['PreToolUse hook', PROJECT, d => (d.settings[PROJECT] = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'guard' }] }] } }), 'a new PreToolUse hook in .claude/settings.json'],
  ['never-lines', USER_MD, d => (d.files[USER_MD] = 'Never a\nNever b\nNever c\n'), '3 new never-lines in ~/.claude/CLAUDE.md'],
  ['rules file', `${CWD}/.claude/rules/x.md`, d => (d.files[`${CWD}/.claude/rules/x.md`] = 'Refuse y\n'), 'a new never-line in .claude/rules/x.md'],
]
for (const [name, , grow, text] of GROWTH) {
  test(`growth in ${name}: one toast with the text`, VULGAR, async ($, on) => {
    const { clock, disk, shown } = world(on, noon)
    disk.settings[USER] = deny(1)
    disk.files[USER_MD] = ''
    disk.files[`${CWD}/.claude/rules/x.md`] = ''
    await start($)
    await clock.settle()
    grow(disk)
    await clock.advance(TICK)
    expect(shown.toasts).toEqual([`${PREFIX}${text}`])
    await clock.advance(TICK)
    expect(shown.toasts).toHaveLength(1)
  })
}

test('several files grow at once: one toast with and N more', VULGAR, async ($, on) => {
  const { clock, disk, shown } = world(on, noon)
  disk.settings[USER] = deny(1)
  disk.files[USER_MD] = ''
  await start($)
  await clock.settle()
  disk.settings[USER] = deny(2)
  disk.settings[PROJECT] = deny(0)
  disk.files[USER_MD] = 'Never a\n'
  await clock.advance(TICK)
  expect(shown.toasts).toEqual([`${PREFIX}a new deny rule in ~/.claude/settings.json and 1 more`])
})

test('a drop shows no toast and lowers the baseline', VULGAR, async ($, on) => {
  const { clock, disk, store, shown } = world(on, noon)
  disk.settings[USER] = deny(3)
  await start($)
  await clock.settle()
  disk.settings[USER] = deny(1)
  await clock.advance(TICK)
  expect(shown.toasts).toEqual([])
  expect(store.get('rules')).toMatchObject({ [USER]: { deny: 1 } })
  disk.settings[USER] = deny(2)
  await clock.advance(TICK)
  expect(shown.toasts).toEqual([`${PREFIX}a new deny rule in ~/.claude/settings.json`])
})

test('plain tone shows nothing and still updates the baseline', async ($, on) => {
  const { clock, disk, store, shown } = world(on, noon)
  disk.settings[USER] = deny(1)
  await start($)
  await clock.settle()
  disk.settings[USER] = deny(4)
  await clock.advance(TICK)
  expect(shown.toasts).toEqual([])
  expect(store.get('rules')).toMatchObject({ [USER]: { deny: 4 } })
})

test('paused shows nothing, updates the baseline, and shows the change never later', VULGAR, async ($, on) => {
  const { clock, disk, store, shown } = world(on, noon)
  disk.settings[USER] = deny(1)
  await start($)
  await clock.settle()
  await $.command.run({ command: 'nudge', args: 'snooze 10m', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  disk.settings[USER] = deny(4)
  await clock.advance(TICK)
  expect(shown.toasts).toEqual([])
  expect(store.get('rules')).toMatchObject({ [USER]: { deny: 4 } })
  await clock.advance(11 * MINUTE)
  expect(shown.toasts).toEqual([])
})

test('an unreadable file is skipped with one debug line and keeps its baseline', VULGAR, async ($, on) => {
  const { clock, disk, store, shown } = world(on, noon)
  disk.settings[USER] = deny(1)
  disk.files[USER_MD] = 'Never a\n'
  await start($)
  await clock.settle()
  disk.unreadable.add(USER_MD)
  disk.files[USER_MD] = 'Never a\nNever b\n'
  await clock.advance(TICK)
  await clock.advance(TICK)
  expect(shown.toasts).toEqual([])
  expect(shown.logs.filter(l => l.includes(USER_MD))).toHaveLength(1)
  expect(store.get('rules')).toMatchObject({ [USER_MD]: { never: 1 }, [USER]: { deny: 1 } })
})

test('rules skips the any lines of the person but uses their rules lines', () => {
  const any = [{ kind: 'any' as const, text: 'whatever {text}' }]
  expect(pickLine(any, 'rules', { text: 'x' })).toBe('Quit being such a bitch: {text}')
  expect(pickLine([...any, { kind: 'rules', text: 'ease up: {text}' }], 'rules', { text: 'x' })).toBe('ease up: {text}')
})

test('a lost roll shows nothing and still updates the baseline', VULGAR, async ($, on) => {
  const { clock, disk, store, shown } = world(on, noon)
  disk.settings[USER] = deny(1)
  await start($)
  await clock.settle()
  roll(0.5)
  disk.settings[USER] = deny(3)
  await clock.advance(TICK)
  expect(shown.toasts).toEqual([])
  expect(store.get('rules')).toMatchObject({ [USER]: { deny: 3 } })
  roll(0.3)
  await clock.advance(TICK)
  expect(shown.toasts).toEqual([])
})

const H = 60 * MINUTE
const AFTER: [string, number, number][] = [
  ['within 12 hours of the last rules toast shows nothing', 11 * H, 0],
  ['after 12 hours a won roll shows one toast', 13 * H, 1],
]
for (const [name, ago, toasts] of AFTER) {
  test(name, VULGAR, async ($, on) => {
    const { clock, disk, store, shown } = world(on, noon)
    disk.settings[USER] = deny(1)
    store.set('rulesShownAt', noon - ago)
    await start($)
    await clock.settle()
    disk.settings[USER] = deny(2)
    await clock.advance(TICK)
    expect(shown.toasts).toHaveLength(toasts)
    disk.settings[USER] = deny(3)
    await clock.advance(TICK)
    expect(shown.toasts).toHaveLength(toasts)
  })
}

test('a project opened for the first time records its files and shows nothing, then growth fires', VULGAR, async ($, on) => {
  const { clock, disk, store, shown } = world(on, noon)
  store.set('rulesScopes', ['user'])
  store.set('rules', { [USER]: { deny: 1, ask: 0, hooks: 0 } })
  disk.settings[USER] = deny(1)
  disk.files[`${CWD}/CLAUDE.md`] = 'Never a\nNever b\n'
  disk.settings[PROJECT] = deny(2)
  await start($)
  await clock.settle()
  expect(shown.toasts).toEqual([])
  expect(store.get('rules')).toMatchObject({ [`${CWD}/CLAUDE.md`]: { never: 2 }, [PROJECT]: { deny: 2 } })
  disk.settings[PROJECT] = deny(3)
  await clock.advance(TICK)
  expect(shown.toasts).toEqual([`${PREFIX}a new deny rule in .claude/settings.json`])
})

test('a rules file created after the first look counts from zero and fires', VULGAR, async ($, on) => {
  const { clock, disk, shown } = world(on, noon)
  disk.settings[USER] = deny(1)
  await start($)
  await clock.settle()
  expect(shown.toasts).toEqual([])
  disk.files[`${CWD}/.claude/rules/new.md`] = 'Never a\nDo not b\n'
  await clock.advance(TICK)
  expect(shown.toasts).toEqual([`${PREFIX}2 new never-lines in .claude/rules/new.md`])
})
