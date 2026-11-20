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
import {
  KINDS,
  MUTED_MAX,
  PAUSE_FOREVER,
  REPO,
  REPO_MAX,
  SIGN_IN_HINT,
  STATUS_MS,
  localZone,
  parseHostedStatus,
  parsePrefs,
  prefsLines,
} from './hosted'
import { KINDS as LINE_KINDS, LINES_MAX, kindForSource, render, parseLine, pickLine, readLines, readTone } from './lines'
import type { Kind, Line, Tone } from './lines'
import { SESSION_ID, carried, register as registerStatusLine, segmentFile, stateDir } from './statusline'
import { TITLES_MAX, cleanTitle, isGhostty, parseTitleArgs, readTitlesOn, titleArgv, ttyPath } from './titles'
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
  isLauncherName,
  isPaid,
  joinSegments,
  limitsText,
  nextText,
  paidText,
  parseSegments,
  setHosted,
  sitText,
  unknownSegments,
} from './status'
import { LAUNCHER, SEPARATOR } from './status'
import type { Free, Launcher, Paid } from './status'
import { SAMPLE_MS, isSampler, localStamp, num, readLog, readSit, report, satMinutes, step } from './sitting'

type Config = { sitMin: number; awayMin: number; bedtime: boolean; controls: Controls; segments: string; tone: Tone; titles: boolean }
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
const FILE_REWRITE_MS = MINUTE

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
  fileBody: undefined as string | undefined,
  fileAt: 0,
  filePath: undefined as string | undefined,
  isEnded: false,
  ticks: 0,
  isBusy: false,
  cloudRun: undefined as object | undefined,
  statusAt: 0,
  statusRun: undefined as object | undefined,
  refresh: Promise.resolve() as Promise<unknown>,
  options: {} as PluginOptions,
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
      tone: readTone(options.tone),
      titles: readTitlesOn(options.titles),
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

/** The line to show for `kind` under the vulgar tone, filled in; null under the plain tone, which keeps its own wording. */
async function say($: EngineInterface, kind: Kind, vars: { minutes?: number; text?: string }): Promise<string | null> {
  if (state.cfg.tone !== 'vulgar') return null
  let lines: Line[] = []
  try {
    lines = readLines(await $.store.get('lines'))
  } catch {
    return null
  }
  return render(pickLine(lines, kind, vars), vars)
}

async function fireDue($: EngineInterface) {
  const now = await $.clock.now()
  if (await isHeldNow($, now)) return
  const due = await locked(() => takeDue($, now))
  for (const n of due) {
    const late = now - n.due > 2 * MINUTE ? ` (due ${span(now - n.due)} ago)` : ''
    const line = await say($, 'reminder', { text: `${n.text}${late}` })
    $.ui.toast(line ?? `nudge: ${n.text}${late}`, { timeoutMs: 15_000 })
    $.ui.notify(line ?? `${n.text}${late}`, { title: 'nudgewhen' }).catch(() => undefined)
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
    if ('server' in got) await $.store.set('cloudServer', got.server)
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
      const line = await say($, kindForSource(n.source), { text: n.text })
      if (!isLive()) return
      $.ui.toast(line ?? `nudge (${n.source}): ${n.text}`, { timeoutMs: 15_000 })
      $.ui.notify(line ?? n.text, { title: `nudgewhen - ${n.source}` }).catch(() => undefined)
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

/** Reads `hosted_status` every `STATUS_MS` while the hosted server is connected, and clears the paid segments when it is not. */
async function fetchHostedStatus($: EngineInterface) {
  if (state.statusRun !== undefined) return
  const server = await $.store.get('cloudServer')
  if ((await $.store.get('cloudUp')) !== true || typeof server !== 'string') {
    state.statusAt = 0
    setHosted(undefined)
    return
  }
  const now = await $.clock.now()
  if (now - state.statusAt < STATUS_MS) return
  state.statusAt = now
  const stop = state.stop
  const run = {}
  state.statusRun = run
  const isLive = () => state.statusRun === run && state.stop === stop
  try {
    const status = parseHostedStatus(await timed($, $.mcp.call(server, 'hosted_status', {})))
    if (!isLive()) return
    setHosted(status ?? undefined)
    await refreshStatus($)
  } catch {
    if (isLive()) setHosted(undefined)
  } finally {
    if (state.statusRun === run) state.statusRun = undefined
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
  name: Free | Paid | Launcher,
  now: number,
  seg: { sat: number | null; usage: SessionUsage | null | undefined },
): Promise<string> {
  const { cfg } = state
  if (isLauncherName(name)) return ''
  if (isPaid(name)) return paidText(name, now)
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

/** Redraws the status line; runs one at a time so an older, slower read never lands after a newer one. */
function refreshStatus($: EngineInterface): Promise<void> {
  const next = state.refresh.then(() => redraw($))
  state.refresh = next.catch(() => undefined)
  return next
}

/** The fired nudges still on show at `now`, with the older ones dropped from the store. */
function shownFired($: EngineInterface, now: number): Promise<Fired[]> {
  return locked(async () => {
    const all = readFired(await $.store.get('fired'))
    const shown = all.filter(f => now - f.at < SHOW_FIRED_MS)
    if (shown.length !== all.length) await $.store.set('fired', shown)
    return shown
  })
}

/** Whether the settings run the plugin's launcher as the status line. */
async function hasLauncher(_$: EngineInterface): Promise<boolean> {
  return carried.value
}

async function onTerminal($: EngineInterface): Promise<boolean> {
  try {
    return (await $.session.surfaces()).includes('terminal')
  } catch {
    return false
  }
}

/** The path of this session's segment file; null when the launcher would not look there. */
async function segmentPath($: EngineInterface): Promise<string | null> {
  const dir = stateDir(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
  return dir === null || !SESSION_ID.test(state.sessionId) ? null : `${dir}/${state.sessionId}.txt`
}

/** Writes the segment file when its body or path changed or a minute has passed, so the launcher never reads a stale stamp. */
async function writeSegments($: EngineInterface, now: number, list: string, rows: [string, string][]) {
  if (state.isEnded) return
  const path = await segmentPath($)
  if (path === null) return
  const body = segmentFile(0, list, rows)
  if (path === state.filePath && body === state.fileBody && now - state.fileAt < FILE_REWRITE_MS) return
  const prev = { body: state.fileBody, at: state.fileAt, path: state.filePath }
  state.fileBody = body
  state.fileAt = now
  state.filePath = path
  // Write beside the target and rename, so the launcher never reads a partly written file.
  const tmp = `${path}.tmp`
  try {
    if ((await run($, ['mkdir', '-p', path.slice(0, path.lastIndexOf('/'))])) === null) throw new Error('mkdir failed')
    await $.fs.write(tmp, segmentFile(now, list, rows))
    if ((await run($, ['mv', '-f', tmp, path])) === null) throw new Error('mv failed')
  } catch (err) {
    state.fileBody = prev.body
    state.fileAt = prev.at
    state.filePath = prev.path ?? path
    $.ui.log(`nudgewhen: ${String(err)}`, { to: 'debug' })
  }
}

async function redraw($: EngineInterface) {
  const { cfg } = state
  const now = await $.clock.now()
  const shown = await shownFired($, now)
  const parts = shown.map(f => `nudge: ${f.text}`)
  const sat = satMinutes(readSit(await $.store.get('sit')), now)
  const isWork = isWorkTime(cfg.controls, now)
  const seg = { sat: isWork ? sat : null, usage: undefined as SessionUsage | null | undefined }
  const names = parseSegments(cfg.segments)
  const rows: [string, string][] = shown.length > 0 ? [['nudge', parts.join(SEPARATOR)]] : []
  for (const name of names) {
    const text = await segment($, name, now, seg)
    parts.push(text)
    rows.push([name, text])
  }
  if ((await hasLauncher($)) && (await onTerminal($))) {
    // The launcher draws the row: leave ui.status empty so the text shows once.
    if (state.lastStatus !== undefined) {
      state.lastStatus = undefined
      $.ui.status(undefined)
    }
    await writeSegments($, now, (shown.length > 0 ? ['nudge', ...names] : names).join(','), rows)
    return
  }
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
    void fetchHostedStatus($).catch(() => undefined)
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
  try {
    const r = await $.config.set({ key: `nudgewhen.${key}`, value })
    if (r.deny !== undefined) return `Could not change ${key}: ${r.deny}`
    state.options = { ...state.options, [key]: value }
    state.cfg = config(state.options).cfg
    return null
  } catch (err) {
    return `Could not change ${key}: ${err instanceof Error ? err.message : String(err)}. Set it in /config instead.`
  }
}

async function hold($: EngineInterface, h: Hold) {
  await locked(() => $.store.set('hold', h))
}

async function statusCommand($: EngineInterface, arg: string): Promise<string> {
  const known = `Free: ${FREE.join(', ')}\nHosted: ${PAID.join(', ')}\nLauncher (with /nudge statusline): ${LAUNCHER.join(', ')}`
  if (arg === '') {
    return `Status line: ${parseSegments(state.cfg.segments).join(',')}\n${known}\nSet it with /nudge status <list>, in the order to show.`
  }
  const unknown = unknownSegments(arg)
  if (unknown.length > 0) return `Unknown: ${unknown.join(', ')}\n${known}`
  const list = parseSegments(arg).join(',')
  return (await setting($, 'status_segments', list)) ?? `Status line is now: ${list}.`
}

const STATUSLINE_USAGE = 'Usage: /nudge statusline wrap|only|off'

/** Sets how the status line launcher runs, or says whether Claude Code carries it now. */
async function statuslineCommand($: EngineInterface, arg: string): Promise<string> {
  if (/^(wrap|only|off)$/i.test(arg)) {
    const mode = arg.toLowerCase()
    return (await setting($, 'status_line', mode)) ?? `Status line launcher is now: ${mode}.`
  }
  if (arg !== '') return STATUSLINE_USAGE
  if (await hasLauncher($)) return `The nudgewhen status line launcher is carried by Claude Code's status line.\n${STATUSLINE_USAGE}`
  const policy = await $.settings.read({ source: 'policy' }).catch(() => ({}) as Record<string, unknown>)
  const mode = state.options.status_line
  if (policy.statusLine === undefined && (mode === 'wrap' || mode === 'only')) {
    return `status_line is ${mode}, but Claude Code skipped nudgewhen's settings hook in this session (its built-in guard; the debug log says settings.read bypassed by cc-plugin-sec-default), so your own status line stays.\n${STATUSLINE_USAGE}`
  }
  const why = policy.statusLine !== undefined ? 'managed policy sets statusLine, which nudgewhen never replaces' : 'status_line is off'
  return `The launcher is not carried: ${why}.\n${STATUSLINE_USAGE}`
}

const KIND_LIST = KINDS.join(',')

/** The hosted server's name when it is connected, else null. */
async function hostedServer($: EngineInterface): Promise<string | null> {
  try {
    const c = await timed($, $.mcp.connect(CLOUD))
    return c.isConnected ? c.server : null
  } catch {
    return null
  }
}

/** Calls a hosted tool; null when the call throws or the server answers with an error. */
async function hostedCall($: EngineInterface, server: string, tool: string, args: Record<string, unknown>) {
  try {
    const r = await timed($, $.mcp.call(server, tool, args))
    return r.isError ? null : r
  } catch {
    return null
  }
}

/** Sends `update` to the hosted server beside the local change; empty when it is not connected, one line when the server refuses. */
async function syncHosted($: EngineInterface, update: Record<string, unknown>): Promise<string> {
  const server = await hostedServer($)
  if (server === null) return ''
  const r = await hostedCall($, server, 'set_prefs', { ...update, tz: localZone() })
  return r === null ? '\nHosted sync failed: /nudge prefs shows what the server has.' : ''
}

const HOSTED_FAILED = 'Could not reach your hosted preferences. Try again.'

async function hostedControl($: EngineInterface, verb: string, arg: string, now: number): Promise<string> {
  let update: Record<string, unknown> | undefined
  let done = ''
  let muted: string | undefined
  switch (verb) {
    case 'prefs':
      break
    case 'mute':
    case 'unmute': {
      if (!REPO.test(arg) || arg.length > REPO_MAX) return `Usage: /nudge ${verb} owner/repo`
      muted = arg.toLowerCase()
      break
    }
    case 'failures-only': {
      const on = /^on$/i.test(arg)
      if (!on && !/^off$/i.test(arg)) return 'Usage: /nudge failures-only on|off'
      update = { failures_only: on }
      done = `Failures only is ${on ? 'on' : 'off'}.`
      break
    }
    default: {
      const kinds = [...new Set(arg.split(/[\s,]+/).filter(k => k !== '').map(k => k.toLowerCase()))]
      if (kinds.length === 0) return `Usage: /nudge kinds ${KIND_LIST}`
      const bad = kinds.filter(k => !(KINDS as readonly string[]).includes(k))
      if (bad.length > 0) return `Unknown kind: ${bad.join(', ')}. Kinds: ${KINDS.join(', ')}`
      update = { kinds }
      done = `Hosted nudges now cover: ${kinds.join(', ')}.`
    }
  }
  const server = await hostedServer($)
  if (server === null) return SIGN_IN_HINT
  if (verb === 'prefs' || muted !== undefined) {
    const got = await hostedCall($, server, 'get_prefs', {})
    const prefs = got === null ? null : parsePrefs(got)
    if (prefs === null) return HOSTED_FAILED
    if (verb === 'prefs') return prefsLines(prefs, now).join('\n')
    const has = prefs.muted_repos.some(r => r.toLowerCase() === muted)
    if (verb === 'mute') {
      if (has) return `${muted} is already muted.`
      if (prefs.muted_repos.length >= MUTED_MAX) return `You already mute ${MUTED_MAX} repos. Unmute some first.`
      update = { muted_repos: [...prefs.muted_repos, muted] }
      done = `Muted ${muted}.`
    } else {
      if (!has) return `${muted} is not muted.`
      update = { muted_repos: prefs.muted_repos.filter(r => r.toLowerCase() !== muted) }
      done = `Unmuted ${muted}.`
    }
  }
  return (await hostedCall($, server, 'set_prefs', update ?? {})) === null ? 'The server refused that change. /nudge prefs shows what it has.' : done
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
      return `Snoozed until ${until(h)}.${await syncHosted($, { paused_until: h.until })}`
    }
    case 'pause': {
      const h = parsePause(arg, now, controls.wakeMin)
      if (h === null) return 'Try "/nudge pause until 14:30" or "/nudge pause tomorrow", or "/nudge pause" to pause until /nudge resume.'
      await hold($, h)
      return `Paused until ${until(h)}.${await syncHosted($, { paused_until: h.until ?? PAUSE_FOREVER })}`
    }
    case 'resume': {
      const was = isHeld(readHold(await $.store.get('hold')), now)
      await locked(() => $.store.delete('hold'))
      const quiet = was && isQuiet(controls, now) ? ' Quiet hours still hold toasts until they end.' : ''
      return `${was ? 'Resumed. Nudges are on.' : 'Nothing was paused.'}${quiet}${await syncHosted($, { paused_until: null })}`
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
        const err = await setting($, key, '')
        if (err !== null) return err
        if (verb === 'hours') return 'Work hours cleared: break nudges run all day.'
        return `Quiet hours cleared.${await syncHosted($, { quiet: '' })}`
      }
      const range = parseRange(arg)
      if (range === null) return `Usage: /nudge ${verb} HH:MM-HH:MM (for example ${verb === 'hours' ? '09:00-17:00' : '22:00-07:00'}); /nudge ${verb} alone clears it.`
      const err = await setting($, key, fmtRange(range))
      if (err !== null) return err
      return `${noun} are now ${fmtRange(range)}.${verb === 'quiet' ? await syncHosted($, { quiet: fmtRange(range) }) : ''}`
    }
    default: {
      if (arg === '') return (await setting($, 'work_days', '')) ?? 'Work days cleared: break nudges run every day.'
      const days = parseDays(arg.replace(/\s+/g, ''))
      if (days === null) return 'Usage: /nudge days mon,tue,wed (mon to sun); /nudge days alone clears it.'
      return (await setting($, 'work_days', fmtDays(days))) ?? `Work days are now ${fmtDays(days)}.`
    }
  }
}

async function toneCommand($: EngineInterface, arg: string): Promise<string> {
  if (arg !== 'plain' && arg !== 'vulgar') return 'Usage: /nudge tone plain|vulgar'
  return (await setting($, 'tone', arg)) ?? `Tone is now ${arg}.`
}

type TitleEntry = { role: string; set: string; cleared?: true }

function readTitleMap(v: unknown): Record<string, TitleEntry> {
  const out: Record<string, TitleEntry> = {}
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [id, e] of Object.entries(v)) {
    const r = (e as Record<string, unknown> | null)?.role
    const s = (e as Record<string, unknown> | null)?.set
    if (typeof r === 'string' && typeof s === 'string') {
      out[id] = (e as Record<string, unknown>).cleared === true ? { role: r, set: s, cleared: true } : { role: r, set: s }
    }
  }
  return out
}

/** The tab and window titles this session wants: the stored pair first, then NUDGEWHEN_ROLE and NUDGEWHEN_SET. */
async function wantedTitles($: EngineInterface): Promise<TitleEntry> {
  const stored = readTitleMap(await $.store.get('titles'))[state.sessionId]
  let role: string | undefined
  let set: string | undefined
  try {
    role = await $.env.get('NUDGEWHEN_ROLE')
  } catch {}
  try {
    set = await $.env.get('NUDGEWHEN_SET')
  } catch {}
  if (stored?.cleared) return { role: '', set: '' }
  return {
    role: cleanTitle(stored?.role ?? '') || cleanTitle(role ?? ''),
    set: cleanTitle(stored?.set ?? '') || cleanTitle(set ?? ''),
  }
}

/** Sets the Ghostty tab and window titles: `skipped` when nothing applies here, `failed` when osascript did not. */
async function setTitles($: EngineInterface, t: TitleEntry, isClear = false): Promise<'ok' | 'skipped' | 'failed'> {
  if (!state.cfg.titles || (!isClear && t.role === '' && t.set === '')) return 'skipped'
  let term: string | undefined
  try {
    term = await $.env.get('TERM_PROGRAM')
  } catch {}
  if (!isGhostty(term)) return 'skipped'
  const tty = ttyPath(await run($, ['sh', '-c', 't=$(ps -o tty= -p $$); case "$t" in *\\?*|"") t=$(ps -o tty= -p $PPID);; esac; echo "$t"']))
  if (tty === null) return 'skipped'
  return (await run($, titleArgv(tty, t.role, t.set))) === null ? 'failed' : 'ok'
}

async function applyTitles($: EngineInterface) {
  await setTitles($, await wantedTitles($))
}

const NOT_SET = 'could not be set here: it needs Ghostty on macOS and titles on.'

/** `/nudge title ...`: the tab title is the session's role, the window title the working set's name. */
async function titleCommand($: EngineInterface, arg: string): Promise<string> {
  const p = parseTitleArgs(arg)
  if (typeof p === 'string') return p
  if ('on' in p || 'off' in p) {
    const v = 'on' in p ? 'on' : 'off'
    return (await setting($, 'titles', v)) ?? `Titles are now ${v}.`
  }
  if ('show' in p) {
    const t = await wantedTitles($)
    return `Tab title: ${t.role || '(none)'}. Window title: ${t.set || '(none)'}. Titles are ${state.cfg.titles ? 'on' : 'off'}.`
  }
  const keep = (next: TitleEntry | null) =>
    locked(async () => {
      const map = readTitleMap(await $.store.get('titles'))
      delete map[state.sessionId]
      if (next !== null) map[state.sessionId] = next
      const ids = Object.keys(map)
      for (const id of ids.slice(0, Math.max(0, ids.length - TITLES_MAX))) delete map[id]
      await $.store.set('titles', map)
    })
  if ('clear' in p) {
    await keep({ role: '', set: '', cleared: true })
    const r = await setTitles($, { role: '', set: '' }, true)
    if (r === 'failed') return 'Titles forgotten, but the Ghostty titles could not be cleared.'
    return 'Titles cleared.'
  }
  const cur = await wantedTitles($)
  const next = 'role' in p ? { ...cur, role: p.role } : { ...cur, set: p.set }
  await keep(next)
  const r = await setTitles($, next)
  if (r !== 'ok') return `Saved, but the title ${r === 'failed' ? 'could not be set (osascript failed).' : NOT_SET}`
  return 'role' in p ? `Tab title is now ${p.role}.` : `Window title is now ${p.set}.`
}

const LINE_USAGE = `Usage: /nudge line add <kind> <text> | line list [kind] | line rm <n>; kinds: ${LINE_KINDS.join(', ')}.`

/** `/nudge line add|list|rm`: the person's own vulgar lines, kept in the store and never sent anywhere. */
async function lineCommand($: EngineInterface, arg: string): Promise<string> {
  const m = /^(add|list|ls|rm)(?:\s+([\s\S]*))?$/i.exec(arg)
  const verb = m?.[1]?.toLowerCase()
  const rest = (m?.[2] ?? '').trim()
  if (verb === 'add') {
    const line = parseLine(rest)
    if (typeof line === 'string') return line
    return locked(async () => {
      const lines = readLines(await $.store.get('lines'))
      if (lines.length >= LINES_MAX) return `You already have ${LINES_MAX} lines. Remove one with /nudge line rm <n>.`
      await $.store.set('lines', [...lines, line])
      return `Added line #${lines.length + 1} (${line.kind}).`
    })
  }
  if (verb === 'list' || verb === 'ls') {
    const kind = rest.toLowerCase()
    if (kind !== '' && !(LINE_KINDS as readonly string[]).includes(kind)) return LINE_USAGE
    const shown = readLines(await $.store.get('lines')).flatMap((l, i) => (kind === '' || l.kind === kind ? [`  #${i + 1}  ${l.kind}  ${l.text}`] : []))
    return shown.length === 0 ? `No lines${kind === '' ? '' : ` for ${kind}`}. Add one with /nudge line add <kind> <text>.` : ['Lines:', ...shown].join('\n')
  }
  if (verb === 'rm') {
    if (!/^\d+$/.test(rest)) return 'Usage: /nudge line rm <n>'
    const n = Number(rest)
    return locked(async () => {
      const lines = readLines(await $.store.get('lines'))
      const hit = lines[n - 1]
      if (hit === undefined) return `No line #${n}. /nudge line list shows them.`
      await $.store.set('lines', lines.filter((_, i) => i !== n - 1))
      return `Removed line #${n}: ${hit.text}`
    })
  }
  return LINE_USAGE
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
  const sl = /^statusline(?:\s+(.*))?$/i.exec(a)
  if (sl) return statuslineCommand($, (sl[1] ?? '').trim())
  const tn = /^tone(?:\s+(.*))?$/i.exec(a)
  if (tn) return toneCommand($, (tn[1] ?? '').trim().toLowerCase())
  const tt = /^title(?:\s+(.*))?$/i.exec(a)
  if (tt) return titleCommand($, (tt[1] ?? '').trim())
  const ln = /^line(?:\s+(.*))?$/i.exec(a)
  if (ln) return lineCommand($, (ln[1] ?? '').trim())
  const hc = /^(prefs|mute|unmute|failures-only|kinds)(?:\s+(.*))?$/i.exec(a)
  if (hc) return hostedControl($, (hc[1] ?? '').toLowerCase(), (hc[2] ?? '').trim(), now)
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
  const line = await say($, 'break', { minutes: sat })
  if (line !== null && (await isHeldNow($, await $.clock.now()))) return
  $.ui.toast(
    line ?? `Agents have this for a few minutes. You've been at the keyboard ${sat}m: walk, refill your water, stretch.`,
    { timeoutMs: 12_000 },
  )
}

async function noteInput($: EngineInterface) {
  if (state.source === 'ioreg' || state.source === 'xprintidle') return
  await $.store.set('lastInput', await $.clock.now())
}

export const register: Register = (on, options) => {
  state.stop?.()
  setHosted(undefined)
  const { queue } = state
  Object.assign(state, fresh(), { queue })
  const read = config(options)
  state.cfg = read.cfg
  state.options = { ...options }
  state.warnings = read.warnings
  registerStatusLine(on, options)

  on('session.start', async ($, e, next) => {
    state.sessionId = await $.session.id()
    state.isEnded = false
    state.fileBody = undefined
    state.fileAt = 0
    await $.command.register({
      name: 'nudge',
      description: 'Set, list or cancel nudges; snooze or pause them; set bedtime, work hours and quiet hours; set the tone, plain or vulgar, and your own lines for it; set the Ghostty tab title (role) and window title (working set); choose status line segments and run the status line launcher; manage hosted nudges; /nudge report shows your sitting log',
      argumentHint: 'in 20m <text> | at 17:30 <text> | every 45m <text> | list | cancel <id> | snooze 30m | pause | resume | bedtime|wake HH:MM | hours|quiet HH:MM-HH:MM | days mon,tue | status <list> | statusline wrap|only|off | tone plain|vulgar | title role|set <text>|clear|on|off | line add <kind> <text>|list|rm <n> | prefs | mute|unmute owner/repo | failures-only on|off | kinds <list> | report',
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
      if (e.surface === null || e.surface === 'terminal') void applyTitles($).catch(() => undefined)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    state.isEnded = true
    state.stop?.()
    state.stop = undefined
    state.cloudRun = undefined
    state.statusRun = undefined
    setHosted(undefined)
    // The launcher keeps wrap's last good prior output beside the segment file, as <session>.prior.
    // Wait for a redraw already in flight, so it cannot recreate the file after the rm.
    await state.refresh
    const path = state.filePath ?? (await segmentPath($))
    if (path !== null) {
      const base = path.replace(/\.txt$/, '')
      if ((await run($, ['rm', '-f', path, `${path}.tmp`, `${base}.prior`])) === null) {
        $.ui.log(`nudgewhen: could not remove ${path}`, { to: 'debug' })
      }
    }
    state.filePath = undefined
    state.fileBody = undefined
    state.fileAt = 0
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
