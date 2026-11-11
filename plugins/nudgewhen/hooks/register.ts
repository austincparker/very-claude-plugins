import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { batches, delayAfter, parsePoll, readIds, readSeen } from './cloud'
import type { HostedNudge } from './cloud'
import { MINUTE, USAGE, afterFiring, describe, hourLabel, isBedtime, parseWhen, span } from './schedule'
import type { Nudge } from './schedule'
import { SAMPLE_MS, isSampler, localStamp, num, readLog, readSit, report, satMinutes, step } from './sitting'

type Config = { sitMin: number; awayMin: number; bedtime: boolean; bedHour: number; wakeHour: number }
type Fired = { id: number; text: string; at: number }
type Source = 'ioreg' | 'xprintidle' | 'prompts'

const TICK_MS = 15_000
const AGENT_EVERY_MS = 30 * MINUTE
const SHOW_FIRED_MS = 10 * MINUTE
const LOG_MAX = 5000
const LOG_KEEP_MS = 90 * 24 * 60 * MINUTE
const NUDGES_MAX = 100
const OWNER_MS = 3 * TICK_MS
const REPROBE_MS = 10 * MINUTE
const TOOL = 'mcp__nudgewhen__nudge'
const CLOUD = 'nudgewhen'

const TOOL_DESCRIPTION = [
  "Sets, lists or cancels the person's nudges: reminders that show in Claude Code and as a desktop notification when due.",
  'Use it when they ask to be reminded or nudged later.',
  "`when` takes 'in 20m', 'in 1h30m', 'at 17:30', 'at 5pm', 'every 45m' or 'every day at 9:00', with `text` saying what to nudge about.",
  "Pass `cancel` with a nudge's id to cancel that one; cancelling them all is the person's own /nudge cancel all. Pass nothing to list the nudges.",
].join(' ')

const fresh = () => ({
  cfg: { sitMin: 30, awayMin: 5, bedtime: true, bedHour: 23, wakeHour: 5 } as Config,
  source: undefined as Source | undefined,
  probedAt: 0,
  sessionId: '',
  lastAgentNudge: 0,
  lastStatus: undefined as string | undefined,
  ticks: 0,
  isBusy: false,
  isPrompting: false,
  stop: undefined as (() => void) | undefined,
  queue: Promise.resolve() as Promise<unknown>,
})
const state = fresh()

/** Runs `fn` after every earlier locked call: store read-modify-writes never interleave in this process. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = state.queue.then(fn, fn)
  state.queue = next.catch(() => undefined)
  return next
}

function config(options: PluginOptions): Config {
  const n = (key: string, fallback: number) => {
    const v = options[key]
    return typeof v === 'number' ? v : fallback
  }
  return {
    sitMin: n('sit_minutes', 30),
    awayMin: n('away_minutes', 5),
    bedtime: options.bedtime_nudge !== false,
    bedHour: n('bedtime_hour', 23),
    wakeHour: n('wake_hour', 5),
  }
}

function readNudges(v: unknown): Nudge[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (n): n is Nudge =>
      n !== null && typeof n === 'object' && typeof n.id === 'number' && typeof n.text === 'string' && typeof n.due === 'number',
  )
}

function readFired(v: unknown): Fired[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (f): f is Fired => f !== null && typeof f === 'object' && typeof f.text === 'string' && typeof f.at === 'number',
  )
}

async function run($: EngineInterface, argv: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(argv, { timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}

async function osIdleMs($: EngineInterface, which: 'ioreg' | 'xprintidle'): Promise<number | null> {
  if (which === 'ioreg') {
    const out = await run($, ['ioreg', '-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime'])
    const m = out === null ? null : /"HIDIdleTime" = (\d+)/.exec(out)
    return m ? Number(m[1]) / 1e6 : null
  }
  const out = await run($, ['xprintidle'])
  const ms = out === null ? Number.NaN : Number(out.trim())
  return Number.isFinite(ms) ? ms : null
}

async function idleMs($: EngineInterface, now: number): Promise<number | null> {
  if (state.source === undefined || (state.source === 'prompts' && now - state.probedAt >= REPROBE_MS)) {
    state.probedAt = now
    for (const which of ['ioreg', 'xprintidle'] as const) {
      const ms = await osIdleMs($, which)
      if (ms !== null) {
        state.source = which
        return ms
      }
    }
    state.source = 'prompts'
  }
  if (state.source === 'prompts') return now - (num(await $.store.get('lastInput')) ?? now)
  return osIdleMs($, state.source)
}

async function sample($: EngineInterface) {
  const now = await $.clock.now()
  const prev = readSit(await $.store.get('sit'))
  if (!isSampler(prev, state.sessionId, now)) return
  const idle = await idleMs($, now)
  if (idle === null) return
  const cur = readSit(await $.store.get('sit'))
  if (cur.updated !== prev.updated || cur.sampler !== prev.sampler) return
  const { sit, log } = step(prev, idle, now, state.cfg.awayMin * MINUTE)
  await $.store.set('sit', { ...sit, sampler: state.sessionId })
  if (readSit(await $.store.get('sit')).sampler !== state.sessionId) return
  if (log.length > 0) {
    const cutoff = localStamp(now - LOG_KEEP_MS)
    const kept = [...readLog(await $.store.get('log')), ...log].filter(r => r[0] >= cutoff)
    await $.store.set('log', kept.slice(-LOG_MAX))
  }
}

/** One session at a time fires nudges: the one that last claimed the store within a few ticks. */
async function ownsFiring($: EngineInterface, now: number): Promise<boolean> {
  const o = await $.store.get('owner')
  const rec = o !== null && typeof o === 'object' ? (o as Record<string, unknown>) : {}
  const at = num(rec.at)
  if (typeof rec.id === 'string' && rec.id !== state.sessionId && at !== null && now - at < OWNER_MS) return false
  await $.store.set('owner', { id: state.sessionId, at: now })
  const back = await $.store.get('owner')
  return back !== null && typeof back === 'object' && (back as Record<string, unknown>).id === state.sessionId
}

async function takeDue($: EngineInterface, now: number): Promise<Nudge[]> {
  if (!(await ownsFiring($, now))) return []
  const nudges = readNudges(await $.store.get('nudges'))
  const due = nudges.filter(n => n.due <= now)
  if (due.length === 0) return []
  await $.store.set('nudges', nudges.flatMap(n => (n.due <= now ? afterFiring(n, now) : [n])))
  const all = readFired(await $.store.get('fired'))
  const shown = all.filter(f => now - f.at < SHOW_FIRED_MS)
  await $.store.set('fired', [...shown, ...due.map(n => ({ id: n.id, text: n.text, at: now }))])
  return due
}

async function fireDue($: EngineInterface) {
  const now = await $.clock.now()
  const due = await locked(() => takeDue($, now))
  for (const n of due) {
    const late = now - n.due > 2 * MINUTE ? ` (due ${span(now - n.due)} ago)` : ''
    $.ui.toast(`nudge: ${n.text}${late}`, { timeoutMs: 15_000 })
    $.ui.notify(`${n.text}${late}`, { title: 'nudgewhen' }).catch(() => undefined)
  }
}

type Attempt = { nudges: HostedNudge[]; server: string } | { reason: string }

async function attempt($: EngineInterface): Promise<Attempt> {
  try {
    const c = await $.mcp.connect(CLOUD)
    if (!c.isConnected) return { reason: c.reason }
    const nudges = parsePoll(await $.mcp.call(c.server, 'poll_nudges', {}))
    return nudges === null ? { reason: 'bad poll result' } : { nudges, server: c.server }
  } catch (err) {
    return { reason: `call failed: ${String(err)}` }
  }
}

async function ackAll($: EngineInterface, server: string, ids: string[]): Promise<string[]> {
  const failed: string[] = []
  for (const batch of batches(ids)) {
    try {
      const r = await $.mcp.call(server, 'ack_nudges', { ids: batch })
      if (r.isError) failed.push(...batch)
    } catch {
      failed.push(...batch)
    }
  }
  return failed
}

/** Records the outcome of one attempt; returns the nudges to show now. */
function settle($: EngineInterface, now: number, got: Attempt): Promise<{ fresh: HostedNudge[]; ack: string[] }> {
  return locked(async () => {
    const fails = 'nudges' in got ? 0 : (num(await $.store.get('cloudFails')) ?? 0) + 1
    const wasUp = (await $.store.get('cloudUp')) !== false
    await $.store.set('cloudFails', fails)
    await $.store.set('cloudNext', now + delayAfter(fails))
    await $.store.set('cloudUp', 'nudges' in got)
    if ('reason' in got) {
      if (wasUp) $.ui.log(`nudgewhen: hosted nudges unavailable (${got.reason}); local nudges keep running`, { to: 'debug' })
      return { fresh: [], ack: [] }
    }
    if (!wasUp) $.ui.log('nudgewhen: connected to hosted nudges', { to: 'debug' })
    const seen = readSeen(await $.store.get('cloudSeen'), now)
    const known = new Set(seen.map(s => s.id))
    const fresh = got.nudges.filter((n, i) => !known.has(n.id) && got.nudges.findIndex(m => m.id === n.id) === i)
    const handedBack = got.nudges.filter(n => known.has(n.id)).map(n => n.id)
    await $.store.set('cloudSeen', [...seen, ...fresh.map(n => ({ id: n.id, at: now }))])
    if (fresh.length > 0) {
      const shown = readFired(await $.store.get('fired')).filter(f => now - f.at < SHOW_FIRED_MS)
      await $.store.set('fired', [...shown, ...fresh.map(n => ({ id: 0, text: `${n.source}: ${n.text}`, at: now }))])
    }
    const pending = readIds(await $.store.get('cloudPending'))
    return { fresh, ack: [...new Set([...pending, ...handedBack, ...fresh.map(n => n.id)])] }
  })
}

async function pollCloud($: EngineInterface) {
  const now = await $.clock.now()
  const isDue = await locked(async () => {
    if (!(await ownsFiring($, now))) return false
    return now >= (num(await $.store.get('cloudNext')) ?? 0)
  })
  if (!isDue) return
  const got = await attempt($)
  const { fresh, ack } = await settle($, now, got)
  for (const n of fresh) {
    $.ui.toast(`nudge (${n.source}): ${n.text}`, { timeoutMs: 15_000 })
    $.ui.notify(n.text, { title: `nudgewhen - ${n.source}` }).catch(() => undefined)
  }
  if (!('server' in got) || ack.length === 0) return
  const failed = await ackAll($, got.server, ack)
  await locked(() => $.store.set('cloudPending', failed))
}

async function refreshStatus($: EngineInterface) {
  const { cfg } = state
  const now = await $.clock.now()
  const all = readFired(await $.store.get('fired'))
  const shown = all.filter(f => now - f.at < SHOW_FIRED_MS)
  if (shown.length !== all.length) await locked(() => $.store.set('fired', shown))
  const parts = shown.map(f => `nudge: ${f.text}`)
  const sat = satMinutes(readSit(await $.store.get('sit')), now)
  if (sat !== null && sat >= 2 * cfg.sitMin) parts.push(`sat ${sat}m · stand up`)
  else if (sat !== null && sat >= cfg.sitMin) parts.push(`sat ${sat}m`)
  if (cfg.bedtime && isBedtime(new Date(now).getHours(), cfg.bedHour, cfg.wakeHour)) {
    parts.push(`past ${hourLabel(cfg.bedHour)} · time to wrap up`)
  }
  const text = parts.length > 0 ? parts.join('  ·  ') : undefined
  if (text !== state.lastStatus) {
    state.lastStatus = text
    $.ui.status(text)
  }
}

async function tick($: EngineInterface) {
  if (state.isBusy) return
  state.isBusy = true
  try {
    if (state.ticks++ % (SAMPLE_MS / TICK_MS) === 0) await sample($)
    await fireDue($)
    await pollCloud($)
    await refreshStatus($)
  } catch (err) {
    $.ui.log(`nudgewhen: ${String(err)}`, { to: 'debug' })
  } finally {
    state.isBusy = false
  }
}

async function list($: EngineInterface, now: number): Promise<string> {
  const nudges = readNudges(await $.store.get('nudges')).sort((a, b) => a.due - b.due)
  const lines = nudges.length
    ? ['Nudges:', ...nudges.map(n => `  #${n.id}  ${describe(n, now)}  ${n.text}`)]
    : ['No nudges set. Try: /nudge in 20m stretch']
  const sat = satMinutes(readSit(await $.store.get('sit')), now)
  lines.push(sat === null ? 'Sitting: no reading yet.' : `Sitting: ${sat}m since your last break.`)
  return lines.join('\n')
}

async function add($: EngineInterface, input: string, now: number): Promise<string> {
  const when = parseWhen(input, now)
  if (typeof when === 'string') return when
  return locked(async () => {
    const nudges = readNudges(await $.store.get('nudges'))
    if (nudges.length >= NUDGES_MAX) return `You already have ${NUDGES_MAX} nudges. Cancel some first.`
    const id = Math.max(num(await $.store.get('nextId')) ?? 0, ...nudges.map(n => n.id)) + 1
    const nudge: Nudge = { id, ...when }
    await $.store.set('nextId', id)
    await $.store.set('nudges', [...nudges, nudge])
    return `Nudge #${id} set for ${describe(nudge, now)}: ${nudge.text}`
  })
}

function cancel($: EngineInterface, which: string): Promise<string> {
  return locked(() => cancelNow($, which))
}

async function cancelNow($: EngineInterface, which: string): Promise<string> {
  const nudges = readNudges(await $.store.get('nudges'))
  if (/^all$/i.test(which)) {
    await $.store.set('nudges', [])
    return nudges.length ? `Cancelled ${nudges.length} nudge${nudges.length === 1 ? '' : 's'}.` : 'No nudges to cancel.'
  }
  const id = Number(which.replace(/^#/, ''))
  const hit = nudges.find(n => n.id === id)
  if (!hit) return `No nudge #${which}. /nudge list shows them.`
  await $.store.set('nudges', nudges.filter(n => n.id !== id))
  return `Cancelled #${id}: ${hit.text}`
}

async function forget($: EngineInterface): Promise<string> {
  await locked(async () => {
    await $.store.set('log', [])
    await $.store.set('fired', [])
  })
  return 'Cleared the sitting log and the record of fired nudges.'
}

async function handle($: EngineInterface, args: string): Promise<string> {
  const a = args.trim()
  const now = await $.clock.now()
  if (a === '' || /^(list|ls)$/i.test(a)) return list($, now)
  if (/^report$/i.test(a)) return report(readLog(await $.store.get('log')))
  if (/^help$/i.test(a)) return USAGE
  if (/^forget$/i.test(a)) return forget($)
  const m = /^(?:cancel|clear|remove|rm|delete)\s+(.+)$/i.exec(a)
  if (m) return cancel($, (m[1] ?? '').trim())
  return add($, a, now)
}

async function answerTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const str = (k: string) => {
    const v = input[k]
    return typeof v === 'string' ? v.trim() : ''
  }
  const now = await $.clock.now()
  if (/^all$/i.test(str('cancel'))) return 'Only the person cancels every nudge, with /nudge cancel all. Cancel one by its id.'
  if (str('cancel')) return cancel($, str('cancel'))
  if (str('when')) return add($, `${str('when')} ${str('text')}`, now)
  return list($, now)
}

async function breakPrompt($: EngineInterface) {
  if (state.isPrompting) return
  state.isPrompting = true
  try {
    await breakPromptNow($)
  } finally {
    state.isPrompting = false
  }
}

async function breakPromptNow($: EngineInterface) {
  const now = await $.clock.now()
  const sat = satMinutes(readSit(await $.store.get('sit')), now)
  if (sat === null || sat < state.cfg.sitMin || now - state.lastAgentNudge < AGENT_EVERY_MS) return
  state.lastAgentNudge = now
  $.ui.toast(
    `Agents have this for a few minutes. You've been at the keyboard ${sat}m: walk, refill your water, stretch.`,
    { timeoutMs: 12_000 },
  )
}

async function noteInput($: EngineInterface) {
  if (state.source === 'ioreg' || state.source === 'xprintidle') return
  await $.store.set('lastInput', await $.clock.now())
}

export const register: Register = (on, options) => {
  state.stop?.()
  const { queue } = state
  Object.assign(state, fresh(), { queue })
  state.cfg = config(options)

  on('session.start', async ($, e, next) => {
    state.sessionId = await $.session.id()
    await $.command.register({
      name: 'nudge',
      description: 'Set, list or cancel nudges; /nudge report shows your sitting log',
      argumentHint: 'in 20m <text> | at 17:30 <text> | every 45m <text> | list | cancel <id> | report',
      immediate: true,
    })
    await $.tool.register({
      name: 'nudge',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          when: { type: 'string', description: "When: 'in 20m', 'at 17:30', 'every 45m', 'every day at 9:00'." },
          text: { type: 'string', description: 'What the nudge says.' },
          cancel: { type: 'string', description: 'The id of the nudge to cancel.' },
        },
      },
    })
    if (e.isInteractive) {
      await $.store.set('lastInput', await $.clock.now())
      state.stop?.()
      const timer = $.clock.every(TICK_MS, () => void tick($))
      state.stop = () => timer.cancel()
      void tick($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    state.stop?.()
    state.stop = undefined
    return next(e)
  })

  on('command.run', { command: 'nudge' }, async ($, e) => ({ text: await handle($, e.args) }))

  on('tool.call', { tool: TOOL }, async ($, e) => ({
    result: await answerTool($, e as unknown as Record<string, unknown>),
  })).catch((_$, _e, next) => ({ deny: `nudgewhen failed: ${String(next.error)}` }))

  on('prompt.submit', async ($, e, next) => {
    await noteInput($).catch(() => undefined)
    return next(e)
  })

  on('tool.call', { tool: ['Agent', 'Workflow'] }, async ($, e, next) => {
    await breakPrompt($).catch(() => undefined)
    return next(e)
  })
}
