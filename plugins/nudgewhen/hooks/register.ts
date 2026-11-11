import type { EngineInterface, PluginOptions, Register, SessionUsage } from 'claude-code'

import { CALL_TIMEOUT_MS, PENDING_MAX, batches, delayAfter, parsePoll, readIds, readSeen } from './cloud'
import type { HostedNudge } from './cloud'
import {
  fmtDays,
  fmtHHMM,
  fmtRange,
  isHeld,
  isQuiet,
  isWorkTime,
  minuteOfDay,
  parseDays,
  parseDuration,
  parseHHMM,
  parsePause,
  parseRange,
  readControls,
  readHold,
} from './controls'
import type { Controls, Hold } from './controls'
import { MINUTE, USAGE, afterFiring, clock, dayHint, describe, parseWhen, span } from './schedule'
import type { Nudge } from './schedule'
import {
  DEFAULT_SEGMENTS,
  FREE,
  PAID,
  bedText,
  breakText,
  breaksText,
  contextText,
  costText,
  isPaid,
  joinSegments,
  limitsText,
  nextText,
  paidText,
  parseSegments,
  sitText,
  unknownSegments,
} from './status'
import { SAMPLE_MS, isSampler, localStamp, num, readLog, readSit, report, satMinutes, step } from './sitting'

type Config = { sitMin: number; awayMin: number; bedtime: boolean; controls: Controls; segments: string }
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
const BRANCH_MS = MINUTE

const TOOL_DESCRIPTION = [
  "Sets, lists or cancels the person's nudges: reminders that show in Claude Code and as a desktop notification when due.",
  'Use it when they ask to be reminded or nudged later.',
  "`when` takes 'in 20m', 'in 1h30m', 'at 17:30', 'at 5pm', 'every 45m', 'every day at 9:00', 'every weekday at 9:00' or 'every mon,wed,fri at 9:00', with `text` saying what to nudge about.",
  "Pass `cancel` with a nudge's id to cancel that one; cancelling them all is the person's own /nudge cancel all. Pass nothing to list the nudges.",
].join(' ')

const fresh = () => ({
  cfg: { sitMin: 30, awayMin: 5, bedtime: true, controls: readControls({}).controls, segments: DEFAULT_SEGMENTS } as Config,
  warnings: [] as string[],
  branch: undefined as { at: number; value: string } | undefined,
  source: undefined as Source | undefined,
  probedAt: 0,
  sessionId: '',
  lastAgentNudge: 0,
  lastStatus: undefined as string | undefined,
  ticks: 0,
  isBusy: false,
  cloudRun: undefined as object | undefined,
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

function config(options: PluginOptions): { cfg: Config; warnings: string[] } {
  const n = (key: string, fallback: number) => {
    const v = options[key]
    return typeof v === 'number' ? v : fallback
  }
  const { controls, warnings } = readControls(options)
  return {
    cfg: {
      sitMin: n('sit_minutes', 30),
      awayMin: n('away_minutes', 5),
      bedtime: options.bedtime_nudge !== false,
      controls,
      segments: typeof options.status_segments === 'string' ? options.status_segments : DEFAULT_SEGMENTS,
    },
    warnings: warnings.map(w => w.text),
  }
}

/** Whether toasts and notifications are held now: inside quiet hours, or under a snooze or pause. */
async function isHeldNow($: EngineInterface, now: number): Promise<boolean> {
  return isQuiet(state.cfg.controls, now) || isHeld(readHold(await $.store.get('hold')), now)
}

/** Shows the warnings about settings that fell back to their defaults, once, when nothing is held. */
async function flushWarnings($: EngineInterface, now: number) {
  if (state.warnings.length === 0 || (await isHeldNow($, now))) return
  for (const text of state.warnings.splice(0)) $.ui.toast(text, { timeoutMs: 15_000 })
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
  if (await isHeldNow($, now)) return
  const due = await locked(() => takeDue($, now))
  for (const n of due) {
    const late = now - n.due > 2 * MINUTE ? ` (due ${span(now - n.due)} ago)` : ''
    $.ui.toast(`nudge: ${n.text}${late}`, { timeoutMs: 15_000 })
    $.ui.notify(`${n.text}${late}`, { title: 'nudgewhen' }).catch(() => undefined)
  }
}

/** `p`, or a rejection once `CALL_TIMEOUT_MS` passes: a hung server never holds the tick. */
function timed<T>($: EngineInterface, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = $.clock.after(CALL_TIMEOUT_MS, () => reject(new Error('timed out')))
    p.then(
      v => {
        timer.cancel()
        resolve(v)
      },
      e => {
        timer.cancel()
        reject(e)
      },
    )
  })
}

type Attempt = { nudges: HostedNudge[]; server: string } | { reason: string }

async function attempt($: EngineInterface): Promise<Attempt> {
  try {
    const c = await timed($, $.mcp.connect(CLOUD))
    if (!c.isConnected) return { reason: c.reason }
    const nudges = parsePoll(await timed($, $.mcp.call(c.server, 'poll_nudges', {})))
    return nudges === null ? { reason: 'bad poll result' } : { nudges, server: c.server }
  } catch (err) {
    return { reason: `call failed: ${String(err)}` }
  }
}

/** Acks `ids` in batches; returns the ids not acked. The first failure queues every later batch too. */
async function ackAll($: EngineInterface, server: string, ids: string[], isLive: () => boolean): Promise<string[]> {
  const failed: string[] = []
  let isDown = false
  for (const batch of batches(ids)) {
    if (isDown || !isLive()) {
      failed.push(...batch)
      continue
    }
    try {
      const r = await timed($, $.mcp.call(server, 'ack_nudges', { ids: batch }))
      if (r.isError) {
        isDown = true
        failed.push(...batch)
      }
    } catch {
      isDown = true
      failed.push(...batch)
    }
  }
  return failed
}

/** Records the outcome of one attempt; returns the nudges to show now. */
function settle($: EngineInterface, got: Attempt): Promise<{ fresh: HostedNudge[]; ack: string[] }> {
  return locked(async () => {
    const now = await $.clock.now()
    if (!(await ownsFiring($, now))) return { fresh: [], ack: [] }
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
    const pending = readIds(await $.store.get('cloudPending'))
    const known = new Set([...seen.map(s => s.id), ...pending])
    const fresh = got.nudges.filter((n, i) => !known.has(n.id) && got.nudges.findIndex(m => m.id === n.id) === i)
    const handedBack = got.nudges.filter(n => known.has(n.id)).map(n => n.id)
    await $.store.set('cloudSeen', [...seen, ...fresh.map(n => ({ id: n.id, at: now }))])
    if (fresh.length > 0) {
      const shown = readFired(await $.store.get('fired')).filter(f => now - f.at < SHOW_FIRED_MS)
      await $.store.set('fired', [...shown, ...fresh.map(n => ({ id: 0, text: `${n.source}: ${n.text}`, at: now }))])
    }
    const ack = [...new Set([...pending, ...handedBack, ...fresh.map(n => n.id)])].slice(-PENDING_MAX)
    await $.store.set('cloudPending', ack)
    return { fresh, ack }
  })
}

/** One hosted poll, run beside the tick so a slow server never holds local nudges. */
async function pollCloud($: EngineInterface) {
  if (state.cloudRun !== undefined) return
  const now = await $.clock.now()
  if (await isHeldNow($, now)) return
  const isDue = await locked(async () => {
    if (!(await ownsFiring($, now))) return false
    return now >= (num(await $.store.get('cloudNext')) ?? 0)
  })
  if (!isDue) return
  const stop = state.stop
  const run = {}
  state.cloudRun = run
  const isLive = () => state.stop === stop
  try {
    const got = await attempt($)
    if (!isLive()) return
    const { fresh, ack } = await settle($, got)
    if (!isLive()) return
    for (const n of fresh) {
      $.ui.toast(`nudge (${n.source}): ${n.text}`, { timeoutMs: 15_000 })
      $.ui.notify(n.text, { title: `nudgewhen - ${n.source}` }).catch(() => undefined)
    }
    if (fresh.length > 0) await refreshStatus($)
    if (!('server' in got) || ack.length === 0) return
    const failed = new Set(await ackAll($, got.server, ack, isLive))
    const done = new Set(ack.filter(id => !failed.has(id)))
    if (done.size === 0) return
    await locked(async () => {
      const current = readIds(await $.store.get('cloudPending'))
      await $.store.set('cloudPending', current.filter(id => !done.has(id)))
    })
  } finally {
    if (state.cloudRun === run) state.cloudRun = undefined
  }
}

/** The usage figures, read once per refresh; null when the engine has none. */
async function usageOf($: EngineInterface, seg: { usage: SessionUsage | null | undefined }): Promise<SessionUsage | null> {
  if (seg.usage === undefined) seg.usage = await $.session.usage().catch(() => null)
  return seg.usage
}

async function branchName($: EngineInterface, now: number): Promise<string> {
  if (state.branch !== undefined && now - state.branch.at < BRANCH_MS) return state.branch.value
  const out = await run($, ['git', 'branch', '--show-current'])
  state.branch = { at: now, value: out === null ? '' : out.trim() }
  return state.branch.value
}

/** One status segment's text, empty when it has nothing to show. `seg.sat` is null outside work hours, so break nudges stay quiet there. */
async function segment(
  $: EngineInterface,
  name: Free | Paid,
  now: number,
  seg: { sat: number | null; usage: SessionUsage | null | undefined },
): Promise<string> {
  const { cfg } = state
  if (isPaid(name)) return paidText(name)
  switch (name) {
    case 'sit':
      return sitText(seg.sat, cfg.sitMin)
    case 'break':
      return breakText(seg.sat, cfg.sitMin)
    case 'next':
      return nextText(readNudges(await $.store.get('nudges')), now)
    case 'bed':
      return cfg.bedtime ? bedText(now, cfg.controls.bedMin, cfg.controls.wakeMin) : ''
    case 'breaks':
      return breaksText(readLog(await $.store.get('log')), now)
    case 'context':
      return contextText((await usageOf($, seg))?.context.percent)
    case 'limits':
      return limitsText((await usageOf($, seg))?.rateLimits ?? [])
    case 'cost':
      return costText((await usageOf($, seg))?.cost?.usd)
    case 'model':
      return (await $.session.model().catch(() => '')) ?? ''
    case 'branch':
      return branchName($, now)
  }
}

async function refreshStatus($: EngineInterface) {
  const { cfg } = state
  const now = await $.clock.now()
  const all = readFired(await $.store.get('fired'))
  const shown = all.filter(f => now - f.at < SHOW_FIRED_MS)
  if (shown.length !== all.length) await locked(() => $.store.set('fired', shown))
  const parts = shown.map(f => `nudge: ${f.text}`)
  const sat = satMinutes(readSit(await $.store.get('sit')), now)
  const isWork = isWorkTime(cfg.controls, now)
  const seg = { sat: isWork ? sat : null, usage: undefined as SessionUsage | null | undefined }
  for (const name of parseSegments(cfg.segments)) parts.push(await segment($, name, now, seg))
  const text = joinSegments(parts) || undefined
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
    await flushWarnings($, await $.clock.now())
    void pollCloud($).catch(err => $.ui.log(`nudgewhen: ${String(err)}`, { to: 'debug' }))
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
  const hold = readHold(await $.store.get('hold'))
  if (isHeld(hold, now)) lines.push(hold?.until == null ? 'Paused until /nudge resume.' : `Held until ${clock(hold.until)}${dayHint(hold.until, now)}.`)
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

/** Writes one `userConfig` field through the engine; null on success, else why it was refused. */
async function setting($: EngineInterface, key: string, value: string): Promise<string | null> {
  const r = await $.config.set({ key: `nudgewhen.${key}`, value })
  return r.deny === undefined ? null : `Could not change ${key}: ${r.deny}`
}

async function hold($: EngineInterface, h: Hold) {
  await locked(() => $.store.set('hold', h))
}

async function statusCommand($: EngineInterface, arg: string): Promise<string> {
  const known = `Free: ${FREE.join(', ')}\nHosted: ${PAID.join(', ')}`
  if (arg === '') {
    return `Status line: ${parseSegments(state.cfg.segments).join(',')}\n${known}\nSet it with /nudge status <list>, in the order to show.`
  }
  const unknown = unknownSegments(arg)
  if (unknown.length > 0) return `Unknown: ${unknown.join(', ')}\n${known}`
  const list = parseSegments(arg).join(',')
  return (await setting($, 'status_segments', list)) ?? `Status line is now: ${list}.`
}

async function control($: EngineInterface, verb: string, arg: string, now: number): Promise<string> {
  const { controls } = state.cfg
  const until = (h: Hold) => (h.until === null ? '/nudge resume' : `${clock(h.until)}${dayHint(h.until, now)}`)
  switch (verb) {
    case 'snooze': {
      const ms = parseDuration(arg)
      if (ms === null) return 'Try "/nudge snooze 30m" (2h and 1h30m work too).'
      const h = { until: now + ms }
      await hold($, h)
      return `Snoozed until ${until(h)}.`
    }
    case 'pause': {
      const h = parsePause(arg, now, controls.wakeMin)
      if (h === null) return 'Try "/nudge pause until 14:30" or "/nudge pause tomorrow", or "/nudge pause" to pause until /nudge resume.'
      await hold($, h)
      return `Paused until ${until(h)}.`
    }
    case 'resume': {
      const was = isHeld(readHold(await $.store.get('hold')), now)
      await locked(() => $.store.delete('hold'))
      return was ? 'Resumed. Nudges are on.' : 'Nothing was paused.'
    }
    case 'bedtime':
    case 'wake': {
      const minute = parseHHMM(arg)
      const noun = verb === 'bedtime' ? 'Bedtime' : 'Wake-up'
      if (minute === null) return `Usage: /nudge ${verb} HH:MM (24-hour, for example ${verb === 'bedtime' ? '22:30' : '06:00'}).`
      return (await setting($, verb, fmtHHMM(minute))) ?? `${noun} is now ${fmtHHMM(minute)}.`
    }
    case 'hours':
    case 'quiet': {
      const noun = verb === 'hours' ? 'Work hours' : 'Quiet hours'
      const key = verb === 'hours' ? 'work_hours' : 'quiet_hours'
      if (arg === '') {
        return (await setting($, key, '')) ?? (verb === 'hours' ? 'Work hours cleared: break nudges run all day.' : 'Quiet hours cleared.')
      }
      const range = parseRange(arg)
      if (range === null) return `Usage: /nudge ${verb} HH:MM-HH:MM (for example ${verb === 'hours' ? '09:00-17:00' : '22:00-07:00'}); /nudge ${verb} alone clears it.`
      return (await setting($, key, fmtRange(range))) ?? `${noun} are now ${fmtRange(range)}.`
    }
    default: {
      if (arg === '') return (await setting($, 'work_days', '')) ?? 'Work days cleared: break nudges run every day.'
      const days = parseDays(arg.replace(/\s+/g, ''))
      if (days === null) return 'Usage: /nudge days mon,tue,wed (mon to sun); /nudge days alone clears it.'
      return (await setting($, 'work_days', fmtDays(days))) ?? `Work days are now ${fmtDays(days)}.`
    }
  }
}

async function handle($: EngineInterface, args: string): Promise<string> {
  const a = args.trim()
  const now = await $.clock.now()
  if (a === '' || /^(list|ls)$/i.test(a)) return list($, now)
  if (/^report$/i.test(a)) return report(readLog(await $.store.get('log')))
  if (/^help$/i.test(a)) return USAGE
  if (/^forget$/i.test(a)) return forget($)
  const st = /^status(?:\s+(.*))?$/i.exec(a)
  if (st) return statusCommand($, (st[1] ?? '').trim())
  const v = /^(snooze|pause|resume|bedtime|wake|hours|days|quiet)(?:\s+(.*))?$/i.exec(a)
  if (v) return control($, (v[1] ?? '').toLowerCase(), (v[2] ?? '').trim(), now)
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
  if (!isWorkTime(state.cfg.controls, now) || (await isHeldNow($, now))) return
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
  const read = config(options)
  state.cfg = read.cfg
  state.warnings = read.warnings

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
          when: { type: 'string', description: "When: 'in 20m', 'at 17:30', 'every 45m', 'every day at 9:00', 'every weekday at 9:00'." },
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
    state.cloudRun = undefined
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
