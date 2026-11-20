import type { CommandInfo, EngineInterface, PluginOptions, Register } from 'claude-code'

import { MINUTE } from './schedule'

type On = Parameters<Register>[0]
type Task = { id: string; type: string }
type Cron = { id: string; prompt: string }
export type Wait = { key: string; label: string }

export const IDLE_AFTER_MS = 2 * MINUTE
const DUE_AFTER_MS = 5000
const DRAFT_WAIT_MS = MINUTE
const DRAFT_WAITS_MAX = 5
const COMMAND = 'idle-check'
const PLUGIN_COMMAND = `nudgewhen:${COMMAND}`

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
  // A re-armed wake-up gets a fresh id and keeps its prompt.
  for (const c of crons) out.push({ key: `cron:${c.prompt}`, label: 'cron' })
  return out
}

export function fresh(ws: readonly Wait[], nudged: ReadonlySet<string>): Wait[] {
  return ws.filter(w => !nudged.has(w.key))
}

/** The person's own `idle-check` command first, then this plugin's. */
export function pickCommand(cmds: readonly CommandInfo[]): string | undefined {
  if (cmds.some(c => c.name === COMMAND && c.source !== 'plugin')) return COMMAND
  if (cmds.some(c => c.name === PLUGIN_COMMAND)) return PLUGIN_COMMAND
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
  isTurnRunning: false,
  isDue: false,
  draftWaits: 0,
  cancel: undefined as (() => void) | undefined,
}

function clearTimer() {
  idle.cancel?.()
  idle.cancel = undefined
}

function arm($: EngineInterface, ms: number, isNudgeNow = false) {
  clearTimer()
  const timer = $.clock.after(ms, () => {
    idle.cancel = undefined
    void (isNudgeNow ? nudge($) : fire($)).catch(err => $.ui.log(`nudgewhen idle: ${String(err)}`, { to: 'debug' }))
  })
  idle.cancel = () => timer.cancel()
}

async function fire($: EngineInterface) {
  if (idle.isTurnRunning) {
    idle.isDue = true
    return
  }
  const draft = await $.prompt.read()
  if (draft.text.trim() !== '' && idle.draftWaits < DRAFT_WAITS_MAX) {
    idle.draftWaits++
    arm($, DRAFT_WAIT_MS)
    return
  }
  await nudge($)
}

/** The waits in the report the Stop settings hook wrote at the end of the last turn; none when it is missing or not this session's. */
export function reportedWaits(text: string | undefined, sessionId: string, startedMonitors: ReadonlySet<string>): Wait[] {
  let r: unknown
  try {
    r = JSON.parse(text ?? '')
  } catch {
    return []
  }
  if (r === null || typeof r !== 'object') return []
  const o = r as Record<string, unknown>
  if (o.session_id !== sessionId || o.stop_hook_active === true || o.agent_id !== undefined) return []
  const rows = (v: unknown) => (Array.isArray(v) ? v.filter(x => x !== null && typeof x === 'object') : [])
  const tasks = rows(o.background_tasks).filter((t): t is Task => typeof t.id === 'string' && typeof t.type === 'string')
  const crons = rows(o.session_crons).filter((c): c is Cron => typeof c.id === 'string' && typeof c.prompt === 'string')
  return waits(tasks, crons, startedMonitors)
}

async function nudge($: EngineInterface) {
  idle.isDue = false
  idle.draftWaits = 0
  if (idle.file === undefined) return
  const text = await $.fs.read(idle.file).catch(() => undefined)
  const due = fresh(reportedWaits(text, idle.sessionId, idle.startedMonitors), idle.nudged)
  if (due.length === 0) return
  for (const w of due) idle.nudged.add(w.key)
  const cmd = pickCommand(await $.command.list().catch(() => []))
  const head = `nudgewhen: idle 2m holding ${summary(due)}`
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
    await $.prompt.submit({ text: `Run the idle check: /${cmd}` })
  } catch (err) {
    $.ui.log(`nudgewhen idle: prompt.submit: ${String(err)}`, { to: 'debug' })
    $.ui.toast(`nudgewhen: could not start it; run /${PLUGIN_COMMAND}`, { timeoutMs: 15_000 })
  }
}

export function registerIdle(on: On, options: PluginOptions): void {
  clearTimer()
  // Every registration drops the timer and turn facts; the session's report file and nudged waits are kept.
  Object.assign(idle, { isTurnRunning: false, isDue: false, draftWaits: 0 })
  if (options.idle_nudge !== true) return

  // register.ts holds the plain session.start and prompt.submit hooks; these take matchers.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    clearTimer()
    idle.sessionId = await $.session.id()
    const dir = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
    const file = `${dir}/nudgewhen-idle-${idle.sessionId}.json`
    // The Stop settings hook in hooks.json writes its input to this file.
    const r = await $.env.set('NUDGEWHEN_IDLE_FILE', file)
    if (r.deny === undefined) idle.file = file
    else $.ui.log(`nudgewhen idle: off for this session: ${r.deny}`, { to: 'debug' })
    return next(e)
  })

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError && typeof r.result?.taskId === 'string') idle.startedMonitors.add(r.result.taskId)
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) idle.isTurnRunning = true
    return next(e)
  })

  on('prompt.submit', { origin: { kind: /^(composer|bridge)$/ } }, async ($, e, next) => {
    clearTimer()
    idle.isDue = false
    idle.draftWaits = 0
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || idle.file === undefined) return next(e)
    idle.isTurnRunning = false
    if (idle.isDue) {
      // Gives the Stop settings hook time to write this turn's report.
      arm($, DUE_AFTER_MS, true)
    } else {
      idle.draftWaits = 0
      arm($, IDLE_AFTER_MS)
    }
    return next(e)
  })
}
