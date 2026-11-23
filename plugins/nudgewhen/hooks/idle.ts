import type { CommandInfo, EngineInterface, PluginOptions, Register } from 'claude-code'

import { logText } from './cloud'
import { MINUTE } from './schedule'

type On = Parameters<Register>[0]
type Task = { id: string; type: string }
type Cron = { id: string; prompt: string }
export type Wait = { key: string; label: string }

export const IDLE_AFTER_MS = 2 * MINUTE
const RETRY_MS = 30_000
const RETRY_MAX = 3
const DRAFT_WAIT_MS = MINUTE
const DRAFT_WAITS_MAX = 5
const PLUGIN = 'nudgewhen'
const DESCRIPTOR = 'idle'
/** A person's own skill under this name runs when they have no `idle-nudge` of their own; it outranks the plugin's `nudgewhen:idle-nudge`. */
const PLUGIN_COMMAND = pluginNudgeCommand(DESCRIPTOR)

const LABELS: Record<string, [string, string]> = {
  shell: ['shell', 'shells'],
  subagent: ['agent', 'agents'],
  workflow: ['workflow', 'workflows'],
  monitor: ['monitor', 'monitors'],
  cron: ['wake-up', 'wake-ups'],
}

/** What this session is waiting on: its background tasks (monitors only when it started them) and its scheduled wake-ups. */
export function waits(tasks: readonly Task[], crons: readonly Cron[], startedMonitors: ReadonlySet<string>): Wait[] {
  const out: Wait[] = []
  for (const t of tasks) {
    if (t.type === 'monitor' && !startedMonitors.has(t.id)) continue
    out.push({ key: `task:${t.id}`, label: t.type })
  }
  // A re-armed wake-up gets a fresh id and keeps its prompt; wake-ups sharing a prompt are told apart by their order.
  const seen = new Map<string, number>()
  for (const c of crons) {
    const n = (seen.get(c.prompt) ?? 0) + 1
    seen.set(c.prompt, n)
    out.push({ key: `cron:${c.prompt}#${n}`, label: 'cron' })
  }
  return out
}

export function fresh(ws: readonly Wait[], nudged: ReadonlySet<string>): Wait[] {
  return ws.filter(w => !nudged.has(w.key))
}

/** Every skill nudgewhen runs for a nudge is named `<descriptor>-nudge`: `idle-nudge` for the idle nudge. */
export function nudgeCommand<D extends string>(descriptor: D): `${D}-nudge` {
  return `${descriptor}-nudge`
}

export function pluginNudgeCommand<D extends string>(descriptor: D): `nudgewhen:${D}-nudge` {
  return `${PLUGIN}:${nudgeCommand(descriptor)}`
}

/**
 * The command a nudge of this descriptor runs: the person's own `<descriptor>-nudge`, then this plugin's, listed bare or with its prefix.
 * "Own" means a command whose `source` is exactly `user`; a plugin, MCP or built-in command never takes that slot.
 */
export function pickNudgeCommand(cmds: readonly CommandInfo[], descriptor: string): string | undefined {
  const own = nudgeCommand(descriptor)
  if (cmds.some(c => c.name === own && c.source === 'user')) return own
  const plugin = pluginNudgeCommand(descriptor)
  if (cmds.some(c => c.name === plugin || (c.source === 'plugin' && c.plugin === PLUGIN && c.name === own))) return plugin
  return undefined
}

/** The command the idle nudge runs. */
export function pickCommand(cmds: readonly CommandInfo[]): string | undefined {
  return pickNudgeCommand(cmds, DESCRIPTOR)
}

export function summary(ws: readonly Wait[]): string {
  const counts = new Map<string, number>()
  for (const w of ws) counts.set(w.label, (counts.get(w.label) ?? 0) + 1)
  const parts = [...counts].map(([label, n]) => {
    const [one, many] = LABELS[label] ?? [label, label]
    return `${n} ${n === 1 ? one : many}`
  })
  return `${ws.length} wait${ws.length === 1 ? '' : 's'} (${parts.join(', ')})`
}

const idle = {
  nudged: new Set<string>(),
  startedMonitors: new Set<string>(),
  file: undefined as string | undefined,
  dir: undefined as string | undefined,
  sessionId: '',
  draftWaits: 0,
  retries: 0,
  gen: 0,
  seq: 0,
  cancel: undefined as (() => void) | undefined,
}

/** Cancels the timer and makes every call already in flight stale: each checks its generation after an await. */
function invalidate() {
  idle.cancel?.()
  idle.cancel = undefined
  idle.gen++
}

function arm($: EngineInterface, ms: number) {
  invalidate()
  const gen = idle.gen
  const timer = $.clock.after(ms, () => {
    idle.cancel = undefined
    void fire($, gen).catch(err => $.ui.log(`nudgewhen idle: ${logText(err)}`, { to: 'debug' }))
  })
  idle.cancel = () => timer.cancel()
}

/** Clears all session state and stops any timer; for tests that share this module. */
export function resetIdle() {
  invalidate()
  Object.assign(idle, { nudged: new Set<string>(), startedMonitors: new Set<string>(), file: undefined, dir: undefined, sessionId: '', draftWaits: 0, retries: 0 })
  idle.seq++
}

/** Empties the report, so a report on disk is always from the turn that just ended. */
async function clearReport($: EngineInterface) {
  if (idle.file === undefined) return
  try {
    await $.fs.write(idle.file, '')
  } catch (err) {
    $.ui.log(`nudgewhen idle: clear report: ${logText(err)}`, { to: 'debug' })
  }
}

async function fire($: EngineInterface, gen: number) {
  const draft = await $.prompt.read()
  if (gen !== idle.gen) return
  if (draft.text.trim() !== '' && idle.draftWaits < DRAFT_WAITS_MAX) {
    idle.draftWaits++
    arm($, DRAFT_WAIT_MS)
    return
  }
  await nudge($, gen)
}

/** The waits in the report the Stop settings hook wrote at the end of the last turn; undefined when it is missing or unreadable, null when it is not the main turn's report for this session (nothing to act on, nothing to forget). */
export function reportedWaits(text: string | undefined, sessionId: string, startedMonitors: ReadonlySet<string>): Wait[] | undefined | null {
  let r: unknown
  try {
    r = JSON.parse(text ?? '')
  } catch {
    return undefined
  }
  if (r === null || typeof r !== 'object') return undefined
  const o = r as Record<string, unknown>
  if (o.session_id !== sessionId || o.stop_hook_active === true || o.agent_id !== undefined) return null
  const rows = (v: unknown) => (Array.isArray(v) ? v.filter(x => x !== null && typeof x === 'object') : [])
  const tasks = rows(o.background_tasks).filter((t): t is Task => typeof t.id === 'string' && typeof t.type === 'string')
  const crons = rows(o.session_crons).filter((c): c is Cron => typeof c.id === 'string' && typeof c.prompt === 'string')
  return waits(tasks, crons, startedMonitors)
}

async function nudge($: EngineInterface, gen: number) {
  idle.draftWaits = 0
  if (idle.file === undefined) return
  const text = await $.fs.read(idle.file).catch(() => undefined)
  if (gen !== idle.gen) return
  const held = reportedWaits(text, idle.sessionId, idle.startedMonitors)
  if (held === undefined) {
    // The Stop settings hook may not have written yet.
    if (idle.retries < RETRY_MAX) {
      idle.retries++
      arm($, RETRY_MS)
    } else {
      $.ui.log('nudgewhen idle: no readable report from the Stop hook; plugin hooks may be off', { to: 'debug' })
    }
    return
  }
  if (held === null) return
  const heldKeys = new Set(held.map(w => w.key))
  for (const k of [...idle.nudged]) if (!heldKeys.has(k)) idle.nudged.delete(k)
  const due = fresh(held, idle.nudged)
  if (due.length === 0) return
  const cmds = await $.command.list().catch(() => [])
  if (gen !== idle.gen) return
  const cmd = pickCommand(cmds)
  const nudged = idle.nudged
  const head = `nudgewhen: idle, holding ${summary(due)}`
  for (const w of due) idle.nudged.add(w.key)
  // Nothing ran for these waits yet: let the next turn's check count them again.
  const unmark = () => {
    if (nudged === idle.nudged) for (const w of due) nudged.delete(w.key)
  }
  if (cmd === undefined) {
    $.ui.toast(`${head}; run /${PLUGIN_COMMAND}`, { timeoutMs: 15_000 })
    return
  }
  $.ui.toast(`${head}; running /${cmd}`, { timeoutMs: 15_000 })
  try {
    await $.command.run({ command: cmd })
    return
  } catch (err) {
    $.ui.log(`nudgewhen idle: command.run: ${logText(err)}`, { to: 'debug' })
  }
  if (gen !== idle.gen) {
    unmark()
    return
  }
  try {
    // The host refuses a submitted prompt that begins with a slash.
    await $.prompt.submit({ text: `You are sitting idle while holding background work, and sitting idle is not necessary. Run the ${cmd} skill now: hand off or finish every wait, or give the valid reason this session must stay.` })
  } catch (err) {
    $.ui.log(`nudgewhen idle: prompt.submit: ${logText(err)}`, { to: 'debug' })
    unmark()
    if (gen === idle.gen) $.ui.toast(`nudgewhen: could not start it; run /${cmd}`, { timeoutMs: 15_000 })
  }
}

/** Removes the session's report and its private directory. */
async function removeReport($: EngineInterface) {
  const { dir } = idle
  idle.file = undefined
  idle.dir = undefined
  await removeDir($, dir)
}

/** Deletes a directory this module made, with whatever the Stop hook left in it. */
async function removeDir($: EngineInterface, dir: string | undefined) {
  if (dir === undefined) return
  try {
    await $.process.run(['rm', '-rf', '--', dir], { timeoutMs: 5000 })
  } catch (err) {
    $.ui.log(`nudgewhen idle: remove report: ${logText(err)}`, { to: 'debug' })
  }
}

/** Stops the idle nudge and deletes the report, which holds scheduled prompts. register.ts calls it from its session.end hook. */
export async function endIdle($: EngineInterface) {
  idle.seq++
  invalidate()
  await removeReport($)
}

/** Makes a mode 700 directory the Stop hook writes into, so no other local user can plant the report. */
async function privateDir($: EngineInterface): Promise<string | undefined> {
  const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
  const r = await $.process.run(['mktemp', '-d', `${tmp}/nudgewhen-idle.XXXXXX`], { timeoutMs: 5000 })
  const dir = r.stdout.trim()
  return r.exitCode === 0 && dir.startsWith(`${tmp}/`) && !dir.includes('\n') ? dir : undefined
}

async function begin($: EngineInterface) {
  invalidate()
  // A newer begin or a session end makes this one stale; a stale begin removes what it made and stops.
  const seq = ++idle.seq
  // A new session in the same process drops the last one's report first.
  await removeReport($)
  if (seq !== idle.seq) return
  Object.assign(idle, { nudged: new Set<string>(), startedMonitors: new Set<string>(), draftWaits: 0, retries: 0 })
  const sessionId = await $.session.id()
  if (seq !== idle.seq) return
  idle.sessionId = sessionId
  const dir = await privateDir($)
  if (seq !== idle.seq) {
    await removeDir($, dir)
    return
  }
  if (dir === undefined) {
    $.ui.log('nudgewhen idle: off for this session: no private directory', { to: 'debug' })
    return
  }
  idle.dir = dir
  // The Stop settings hook in hooks.json writes its input to $NUDGEWHEN_IDLE_DIR/nudgewhen-idle-<its session id>.json.
  const r = await $.env.set('NUDGEWHEN_IDLE_DIR', dir)
  if (seq !== idle.seq) {
    await removeDir($, dir)
    return
  }
  if (r.deny === undefined) {
    idle.file = `${dir}/nudgewhen-idle-${idle.sessionId}.json`
  } else {
    $.ui.log(`nudgewhen idle: off for this session: ${logText(r.deny)}`, { to: 'debug' })
    await removeReport($)
  }
}

export function registerIdle(on: On, options: PluginOptions): void {
  invalidate()
  // Every registration drops the timer and turn facts; the session's report file and nudged waits are kept.
  Object.assign(idle, { draftWaits: 0, retries: 0 })
  if (options.idle_nudge !== true) return

  // register.ts holds the plain session.start and prompt.submit hooks; these take matchers.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    try {
      await begin($)
    } catch (err) {
      $.ui.log(`nudgewhen idle: off for this session: ${logText(err)}`, { to: 'debug' })
      await removeReport($)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError && typeof r.result?.taskId === 'string') idle.startedMonitors.add(r.result.taskId)
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      invalidate()
      idle.draftWaits = 0
      await clearReport($)
    }
    return next(e)
  })

  on('prompt.submit', { origin: { kind: /^(composer|bridge)$/ } }, async ($, e, next) => {
    invalidate()
    idle.draftWaits = 0
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && !e.isAborted && idle.file !== undefined) {
      idle.draftWaits = 0
      idle.retries = 0
      arm($, IDLE_AFTER_MS)
    }
    return next(e)
  })
}
