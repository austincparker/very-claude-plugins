import type { CommandInfo, EngineInterface, PluginOptions, Register } from 'claude-code'

import { MINUTE } from './schedule'

type On = Parameters<Register>[0]
type Task = { id: string; type: string }
type Cron = { id: string; prompt: string }
export type Wait = { key: string; label: string }

export const IDLE_AFTER_MS = 2 * MINUTE
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
  isInteractive: false,
  isTurnRunning: false,
  isDue: false,
  draftWaits: 0,
  current: [] as Wait[],
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

async function nudge($: EngineInterface) {
  const due = fresh(idle.current, idle.nudged)
  idle.isDue = false
  idle.draftWaits = 0
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
  // Every registration drops the timer and turn facts; the nudged waits are kept.
  Object.assign(idle, { isTurnRunning: false, isDue: false, draftWaits: 0, current: [] })
  if (options.idle_nudge !== true) return

  // register.ts holds the plain session.start and prompt.submit hooks; these take matchers.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    clearTimer()
    idle.isInteractive = true
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

  on('classic.Stop', async ($, e, next) => {
    idle.isTurnRunning = false
    if (!idle.isInteractive || e.stop_hook_active || e.agent_id !== undefined) return next(e)
    idle.current = waits(e.background_tasks ?? [], e.session_crons ?? [], idle.startedMonitors)
    const due = fresh(idle.current, idle.nudged)
    if (due.length === 0) {
      clearTimer()
      idle.isDue = false
    } else if (idle.isDue) {
      // $.command.run rejects inside a hook the turn waits on.
      arm($, 0, true)
    } else {
      idle.draftWaits = 0
      arm($, IDLE_AFTER_MS)
    }
    return next(e)
  })
}
