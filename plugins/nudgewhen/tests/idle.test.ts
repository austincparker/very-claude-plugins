import type { CommandInfo, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { IDLE_AFTER_MS, pickCommand, reportedWaits, resetIdle } from '../hooks/idle'
import { MINUTE } from '../hooks/schedule'

const ON = { options: { idle_nudge: true } }
const PLUGIN_CMD: CommandInfo = { name: 'nudgewhen:idle-check', description: '', source: 'plugin', plugin: 'nudgewhen' }

type Stop = { tasks?: readonly { id: string; type: string }[]; crons?: readonly { id: string; prompt: string }[]; session?: string; active?: boolean; report?: string | null }
type World = { commands?: CommandInfo[]; draft?: () => string; runFails?: boolean; submitFails?: boolean; envFails?: boolean; mktempFails?: boolean }

/** The engine beneath the mod: what it lists, and a record of what the mod ran, submitted and showed. */
function world(on: On, w: World = {}) {
  resetIdle()
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, {})
  const seen = { runs: [] as string[], submits: [] as string[], toasts: [] as string[], envSets: [] as string[], procs: [] as string[] }
  const files = new Map<string, string>()
  let reportPath = ''
  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'session-a' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nudgewhen__${e.name}` } }))
  on('process.run', (_, e) => {
    const [cmd] = e.argv
    if (cmd === 'mktemp' || cmd === 'rm' || cmd === 'rmdir') seen.procs.push(e.argv.join(' '))
    const ok = cmd === 'mktemp' ? !w.mktempFails : cmd === 'rm' || cmd === 'rmdir'
    const stdout = cmd === 'mktemp' && ok ? '/tmp/t/nudgewhen-idle.AbC123\n' : ''
    return { value: { exitCode: ok ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('command.list', () => ({ value: w.commands ?? [PLUGIN_CMD] }))
  on('prompt.read', () => ({ value: { text: w.draft?.() ?? '', cursor: 0 } }))
  // Handing a call on with nothing beneath is how a test makes it reject.
  on('command.run', (_, e, next) => {
    if (e.origin.kind === 'plugin') seen.runs.push(e.command)
    return w.runFails ? next(e) : { text: '' }
  })
  on('prompt.submit', (_, e, next) => {
    if (e.origin.kind !== 'plugin') return { text: e.text }
    seen.submits.push(e.text)
    return w.submitFails ? next(e) : { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', (_, e) => ({ result: e.tool === 'Monitor' ? { taskId: 'mon-mine', timeoutMs: 0 } : {} }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('env.get', (_, e) => ({ value: e.name === 'TMPDIR' ? '/tmp/t/' : undefined }))
  on('env.set', (_, e, next) => {
    if (w.envFails) return next(e)
    seen.envSets.push(`${e.name}=${e.value}`)
    reportPath = `${e.value}/nudgewhen-idle-session-a.json`
    return { value: {} }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  // No file: handed on with nothing beneath, so the read rejects as a missing file does.
  on('fs.read', (_, e, next) => {
    const text = files.get(e.path)
    return text === undefined ? next(e) : { value: text }
  })
  /** Ends a main-loop turn the way a session does: the Stop settings hook writes its input, then the turn completes. */
  const stop = async ($: Engine, s: Stop) => {
    await $.turn.start({ text: '', turnId: 't' })
    if (reportPath !== '' && s.report !== null) {
      files.set(reportPath, s.report ?? JSON.stringify({
        session_id: s.session ?? 'session-a',
        stop_hook_active: s.active ?? false,
        background_tasks: (s.tasks ?? []).map(t => ({ ...t, status: 'running', description: 'x' })),
        session_crons: (s.crons ?? []).map(c => ({ ...c, schedule: '* * * * *', recurring: false })),
      }))
    }
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  }
  return { clock, seen, stop }
}


function start($: Engine, isInteractive = true) {
  return $.session.start({ cwd: '/', surface: 'terminal', isInteractive })
}

test('the setting off: nothing runs', async ($, on) => {
  const { clock, seen, stop } = world(on)
  await start($)
  await stop($, { tasks: [{ id: 'off-1', type: 'shell' }] })
  await clock.advance(IDLE_AFTER_MS + MINUTE)
  expect(seen.runs).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(seen.envSets).toEqual([])
})

test('the setting on: the Stop hook is pointed at a directory', ON, async ($, on) => {
  const { seen } = world(on)
  await start($)
  expect(seen.procs).toEqual(['mktemp -d /tmp/t/nudgewhen-idle.XXXXXX'])
  expect(seen.envSets).toEqual(['NUDGEWHEN_IDLE_DIR=/tmp/t/nudgewhen-idle.AbC123'])
})

test('a shell held two minutes runs the check once per wait', ON, async ($, on) => {
  const { clock, seen, stop } = world(on)
  await start($)
  await stop($, { tasks: [{ id: 'sh-1', type: 'shell' }], crons: [{ id: 'c1', prompt: 'check ci' }] })
  await clock.advance(IDLE_AFTER_MS - 1000)
  expect(seen.runs).toEqual([])
  await clock.advance(1000)
  expect(seen.runs).toEqual(['nudgewhen:idle-check'])
  expect(seen.toasts).toEqual(['nudgewhen: idle, holding 2 waits (1 shell, 1 wake-up); running /nudgewhen:idle-check'])

  await stop($, { tasks: [{ id: 'sh-1', type: 'shell' }], crons: [{ id: 'c2', prompt: 'check ci' }] })
  await clock.advance(IDLE_AFTER_MS)
  expect(seen.runs.length).toBe(1)

  await stop($, { tasks: [{ id: 'sh-1', type: 'shell' }, { id: 'sh-2', type: 'shell' }] })
  await clock.advance(IDLE_AFTER_MS)
  expect(seen.runs.length).toBe(2)
})

test('a prompt from the person before the timer stops it', ON, async ($, on) => {
  const { clock, seen, stop } = world(on)
  await start($)
  await stop($, { tasks: [{ id: 'pp-1', type: 'shell' }] })
  await clock.advance(MINUTE)
  await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, wait: false })
  await clock.advance(IDLE_AFTER_MS)
  expect(seen.runs).toEqual([])
})

test('a draft in the prompt box postpones the check', ON, async ($, on) => {
  let draft = 'half a thought'
  const { clock, seen, stop } = world(on, { draft: () => draft })
  await start($)
  await stop($, { tasks: [{ id: 'dr-1', type: 'shell' }] })
  await clock.advance(IDLE_AFTER_MS + MINUTE)
  expect(seen.runs).toEqual([])
  draft = ''
  await clock.advance(MINUTE)
  expect(seen.runs).toEqual(['nudgewhen:idle-check'])
})

test('a turn that starts cancels the pending check, and the next turn end re-arms it', ON, async ($, on) => {
  const { clock, seen, stop } = world(on)
  await start($)
  await stop($, { tasks: [{ id: 'mt-1', type: 'shell' }] })
  await clock.advance(MINUTE)
  await $.turn.start({ text: '', turnId: 't1' })
  await clock.advance(IDLE_AFTER_MS)
  expect(seen.runs).toEqual([])
  await stop($, { tasks: [{ id: 'mt-1', type: 'shell' }] })
  await clock.advance(IDLE_AFTER_MS - 1000)
  expect(seen.runs).toEqual([])
  await clock.advance(1000)
  expect(seen.runs).toEqual(['nudgewhen:idle-check'])
})

test('an aborted turn does not read the report of an earlier one', ON, async ($, on) => {
  const { clock, seen, stop } = world(on)
  await start($)
  await stop($, { tasks: [{ id: 'ab-1', type: 'shell' }] })
  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'answer' })
  await clock.advance(IDLE_AFTER_MS * 2)
  expect(seen.runs).toEqual([])
})

test('waits that did not get a nudge are tried again; a wake-up made again nudges again', ON, async ($, on) => {
  const w: World = { runFails: true, submitFails: true }
  const { clock, seen, stop } = world(on, w)
  await start($)
  await stop($, { crons: [{ id: 'c1', prompt: 'poll' }] })
  await clock.advance(IDLE_AFTER_MS)
  w.runFails = false
  w.submitFails = false
  await stop($, { crons: [{ id: 'c2', prompt: 'poll' }] })
  await clock.advance(IDLE_AFTER_MS)
  expect(seen.runs.length).toBe(2)
  await stop($, {})
  await clock.advance(IDLE_AFTER_MS)
  await stop($, { crons: [{ id: 'c3', prompt: 'poll' }] })
  await clock.advance(IDLE_AFTER_MS)
  expect(seen.runs.length).toBe(3)
})

test('two wake-ups with one prompt count as two waits', ON, async ($, on) => {
  const { clock, seen, stop } = world(on)
  await start($)
  await stop($, { crons: [{ id: 'c1', prompt: 'poll' }, { id: 'c2', prompt: 'poll' }] })
  await clock.advance(IDLE_AFTER_MS)
  expect(seen.toasts[0]).toMatch(/holding 2 waits \(2 wake-ups\)/)
})

test('a session whose environment cannot be set stays quiet, starts, and drops its directory', ON, async ($, on) => {
  const { clock, seen, stop } = world(on, { envFails: true })
  await start($)
  await stop($, { tasks: [{ id: 'ef-1', type: 'shell' }] })
  await clock.advance(IDLE_AFTER_MS + MINUTE)
  expect(seen.runs).toEqual([])
  expect(seen.procs).toContain('rmdir /tmp/t/nudgewhen-idle.AbC123')
})

test('a session with no private directory stays quiet', ON, async ($, on) => {
  const { clock, seen, stop } = world(on, { mktempFails: true })
  await start($)
  await stop($, { tasks: [{ id: 'mk-1', type: 'shell' }] })
  await clock.advance(IDLE_AFTER_MS + MINUTE)
  expect(seen.envSets).toEqual([])
  expect(seen.runs).toEqual([])
})

test('the session ending deletes the report and its directory', ON, async ($, on) => {
  const { clock, seen, stop } = world(on)
  await start($)
  await stop($, { tasks: [{ id: 'se-1', type: 'shell' }] })
  await $.session.end({ sessionId: 'session-a', reason: 'other', resume: { id: 'session-a' } })
  expect(seen.procs.slice(-2)).toEqual([
    'rm -f -- /tmp/t/nudgewhen-idle.AbC123/nudgewhen-idle-session-a.json',
    'rmdir /tmp/t/nudgewhen-idle.AbC123',
  ])
  await clock.advance(IDLE_AFTER_MS + MINUTE)
  expect(seen.runs).toEqual([])
})

for (const [name, report] of [
  ['an empty report', ''],
  ['a truncated report', '{"session_id":"session-a","background_tasks":[{"id":"tr-1","ty'],
  ['no report from the hook', null],
] as const) {
  test(`${name}: nothing runs, and the check gives up after its retries`, ON, async ($, on) => {
    const { clock, seen, stop } = world(on)
    await start($)
    await stop($, { tasks: [{ id: 'tr-1', type: 'shell' }], report })
    await clock.advance(IDLE_AFTER_MS + 10 * MINUTE)
    expect(seen.runs).toEqual([])
    expect(seen.toasts).toEqual([])
  })
}

test('a report left by an earlier turn is not read after a turn the hook did not report', ON, async ($, on) => {
  const { clock, seen, stop } = world(on)
  await start($)
  await stop($, { tasks: [{ id: 'st-1', type: 'shell' }] })
  await clock.advance(IDLE_AFTER_MS)
  expect(seen.runs.length).toBe(1)
  await stop($, { tasks: [{ id: 'st-2', type: 'shell' }], report: null })
  await clock.advance(IDLE_AFTER_MS + 10 * MINUTE)
  expect(seen.runs.length).toBe(1)
})

test('a monitor started with the Monitor tool counts', ON, async ($, on) => {
  const { clock, seen, stop } = world(on)
  await start($)
  await $.tool.call({ tool: 'Monitor', description: 'x', timeout_ms: 1000, command: 'true' })
  await stop($, { tasks: [{ id: 'mon-mine', type: 'monitor' }] })
  await clock.advance(IDLE_AFTER_MS)
  expect(seen.runs).toEqual(['nudgewhen:idle-check'])
})

test('no idle-check command: the toast alone', ON, async ($, on) => {
  const none = world(on, { commands: [] })
  const stop = none.stop
  await start($)
  await stop($, { tasks: [{ id: 'nc-1', type: 'shell' }] })
  await none.clock.advance(IDLE_AFTER_MS)
  expect(none.seen.runs).toEqual([])
  expect(none.seen.toasts.at(-1)).toMatch(/run \/nudgewhen:idle-check$/)
})

test('a refused command.run falls back to a prompt, then the toast', ON, async ($, on) => {
  const { clock, seen, stop } = world(on, { runFails: true, submitFails: true })
  await start($)
  await stop($, { tasks: [{ id: 'rf-1', type: 'workflow' }] })
  await clock.advance(IDLE_AFTER_MS)
  expect(seen.runs).toEqual(['nudgewhen:idle-check'])
  expect(seen.submits).toEqual(['Use the nudgewhen:idle-check skill now.'])
  expect(seen.toasts.at(-1)).toMatch(/run \/nudgewhen:idle-check$/)
})

test('reportedWaits reads nothing from a missing or broken report', () => {
  const rows: [string | undefined, number][] = [
    [undefined, 0],
    ['not json', 0],
    ['null', 0],
    ['{"session_id":"s","background_tasks":[{"id":"a","type":"shell"},{"id":1},null]}', 1],
  ]
  for (const [text, want] of rows) expect(reportedWaits(text, 's', new Set())?.length ?? 0).toBe(want)
})

test('pickCommand prefers the person\'s own idle-check', () => {
  const own: CommandInfo = { name: 'idle-check', description: '', source: 'user' }
  const other: CommandInfo = { name: 'idle-check', description: '', source: 'plugin', plugin: 'else' }
  const rows: [CommandInfo[], string | undefined][] = [
    [[PLUGIN_CMD, own], 'idle-check'],
    [[PLUGIN_CMD, other], 'nudgewhen:idle-check'],
    [[{ name: 'idle-check', description: '', source: 'plugin', plugin: 'nudgewhen' }], 'nudgewhen:idle-check'],
    [[other], undefined],
    [[], undefined],
  ]
  for (const [cmds, want] of rows) expect(pickCommand(cmds)).toBe(want)
})
