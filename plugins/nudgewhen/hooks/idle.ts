import type { CommandInfo, EngineInterface, PluginOptions, Register } from 'claude-code'

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
const COMMAND = 'idle-check'
const PLUGIN = 'nudgewhen'
const PLUGIN_COMMAND = `${PLUGIN}:${COMMAND}`

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

/** The person's own `idle-check` command first, then this plugin's, listed bare or with its plugin prefix. */
export function pickCommand(cmds: readonly CommandInfo[]): string | undefined {
  if (cmds.some(c => c.name === COMMAND && c.source !== 'plugin')) return COMMAND
  if (cmds.some(c => c.name === PLUGIN_COMMAND || (c.name === COMMAND && c.source === 'plugin' && c.plugin === PLUGIN))) {
    return PLUGIN_COMMAND
  }
  return undefined
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
  sessionId: '',
  draftWaits: 0,
  retries: 0,
  gen: 0,
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
    void fire($, gen).catch(err => $.ui.log(`nudgewhen idle: ${String(err)}`, { to: 'debug' }))
  })
  idle.cancel = () => timer.cancel()
}

/** Empties the report, so a report on disk is always from the turn that just ended. */
async function clearReport($: EngineInterface) {
  if (idle.file === undefined) return
  try {
    await $.fs.write(idle.file, '')
  } catch (err) {
    $.ui.log(`nudgewhen idle: clear report: ${String(err)}`, { to: 'debug' })
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

/** The waits in the report the Stop settings hook wrote at the end of the last turn; undefined when it is missing or unreadable, none when it is not this session's. */
export function reportedWaits(text: string | undefined, sessionId: string, startedMonitors: ReadonlySet<string>): Wait[] | undefined {
  let r: unknown
  try {
    r = JSON.parse(text ?? '')
  } catch {
    return undefined
  }
  if (r === null || typeof r !== 'object') return undefined
  const o = r as Record<string, unknown>
  if (o.session_id !== sessionId || o.stop_hook_active === true || o.agent_id !== undefined) return []
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
    }
    return
  }
  const heldKeys = new Set(held.map(w => w.key))
  for (const k of [...idle.nudged]) if (!heldKeys.has(k)) idle.nudged.delete(k)
  const due = fresh(held, idle.nudged)
  if (due.length === 0) return
  const cmds = await $.command.list().catch(() => [])
  if (gen !== idle.gen) return
  const cmd = pickCommand(cmds)
  const head = `nudgewhen: idle 2m holding ${summary(due)}`
  for (const w of due) idle.nudged.add(w.key)
  if (cmd === undefined) {
    $.ui.toast(`${head}; run /${PLUGIN_COMMAND}`, { timeoutMs: 15_000 })
    return
  }
  $.ui.toast(`${head}; running /${cmd}`, { timeoutMs: 15_000 })
  try {
    await $.command.run({ command: cmd })
    return
  } catch (err) {
    $.ui.log(`nudgewhen idle: command.run: ${String(err)}`, { to: 'debug' })
  }
  try {
    // The host refuses a submitted prompt that begins with a slash.
    await $.prompt.submit({ text: `Use the ${cmd} skill now.` })
  } catch (err) {
    $.ui.log(`nudgewhen idle: prompt.submit: ${String(err)}`, { to: 'debug' })
    // Nothing ran: leave these waits for the next turn's check.
    for (const w of due) idle.nudged.delete(w.key)
    $.ui.toast(`nudgewhen: could not start it; run /${PLUGIN_COMMAND}`, { timeoutMs: 15_000 })
  }
}

/** Stops the check and empties the report, which holds scheduled prompts. register.ts calls it from its session.end hook. */
export async function endIdle($: EngineInterface) {
  invalidate()
  await clearReport($)
  idle.file = undefined
}

async function begin($: EngineInterface) {
  invalidate()
  Object.assign(idle, { nudged: new Set<string>(), startedMonitors: new Set<string>(), file: undefined, draftWaits: 0, retries: 0 })
  idle.sessionId = await $.session.id()
  const dir = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
  // The Stop settings hook in hooks.json writes its input to <dir>/nudgewhen-idle-<its session id>.json.
  const r = await $.env.set('NUDGEWHEN_IDLE_DIR', dir)
  if (r.deny === undefined) idle.file = `${dir}/nudgewhen-idle-${idle.sessionId}.json`
  else $.ui.log(`nudgewhen idle: off for this session: ${r.deny}`, { to: 'debug' })
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
      $.ui.log(`nudgewhen idle: off for this session: ${String(err)}`, { to: 'debug' })
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
