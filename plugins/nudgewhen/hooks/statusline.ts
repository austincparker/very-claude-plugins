import type { Register } from 'claude-code'

type SettingsLayer = { source: string; settings: Readonly<Record<string, unknown>> }

export const STATE_DIR = '${CLAUDE_CONFIG_DIR:-$HOME/.claude}/nudgewhen/status'
export const INTERVAL_MAX = 30
/** The launcher's last argument: `-` or base64, nothing the shell would read as syntax. */
const PRIOR_ARG = /^(-|[A-Za-z0-9+/=]+)$/
export const SESSION_ID = /^[A-Za-z0-9_-]+$/

export type StatusMode = 'wrap' | 'only'
type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** True for the plugin's own key in `pluginConfigs`: `nudgewhen` or `nudgewhen@<marketplace>`. */
const isOwnKey = (k: string) => k === 'nudgewhen' || k.startsWith('nudgewhen@')

/**
 * The mode the highest-precedence layer that sets `status_line` asks for (layers are lowest first);
 * null when none sets it, or the value is off or not `wrap` or `only`.
 */
export function readMode(layers: readonly SettingsLayer[]): StatusMode | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const configs = layers[i]?.settings.pluginConfigs
    if (!isObj(configs)) continue
    for (const [key, cfg] of Object.entries(configs)) {
      if (!isOwnKey(key) || !isObj(cfg) || !isObj(cfg.options)) continue
      const v = cfg.options.status_line
      if (v === undefined) continue
      const mode = typeof v === 'string' ? v.trim().toLowerCase() : ''
      return mode === 'wrap' || mode === 'only' ? mode : null
    }
  }
  return null
}

/** True when Claude Code will not run a non-managed `statusLine`: hooks are all disabled, or only managed hooks run. */
export function hooksOff(layers: readonly SettingsLayer[], prior: Readonly<Obj>): boolean {
  if (prior.disableAllHooks === true || layers.some(l => l.settings.disableAllHooks === true)) return true
  return layers.some(l => l.source === 'policy' && l.settings.allowManagedHooksOnly === true)
}

/** True when `v` is a `statusLine` setting that runs the plugin's launcher, wherever the plugin is installed. */
export function isLauncher(v: unknown): boolean {
  const cmd = isObj(v) ? v.command : undefined
  return typeof cmd === 'string' && ['wrap', 'only'].some(mode => cmd.includes(`/bin/statusline ${mode} "${STATE_DIR}" `))
}

/** The directory the launcher reads segment files from, as its shell expands STATE_DIR; null when neither variable is set. */
export function stateDir(cfg: string | undefined, home: string | undefined): string | null {
  if (cfg) return `${cfg}/nudgewhen/status`
  return home ? `${home}/.claude/nudgewhen/status` : null
}

/** The segment file: a version and time stamp, the order line, then one `name<TAB>text` row per non-empty text. */
export function segmentFile(now: number, list: string, rows: readonly (readonly [string, string])[]): string {
  const flat = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  const body = rows.filter(([, text]) => text !== '').map(([name, text]) => `${flat(name)}\t${flat(text)}\n`)
  return `v1 ${now}\n${flat(list)}\n${body.join('')}`
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 of the UTF-8 bytes of `s`; the hook runtime has no Buffer. */
export function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The settings with `statusLine` pointed at the plugin's script, or null when the read is to pass through:
 * the option is off or invalid, the policy layer holds `statusLine`, or hooks are disabled. Pure: the same inputs give the same answer.
 */
export function answer(layers: readonly SettingsLayer[], prior: Readonly<Obj>, root: string): Obj | null {
  const mode = readMode(layers)
  if (mode === null) return null
  if (layers.some(l => l.source === 'policy' && l.settings.statusLine !== undefined)) return null
  if (hooksOff(layers, prior)) return null
  const old = isObj(prior.statusLine) ? prior.statusLine : {}
  // A statusLine that already runs the launcher is not wrapped again: its own prior command is carried over.
  const carriedCmd = (c: string) => {
    const last = c.slice(c.lastIndexOf(' ') + 1)
    return PRIOR_ARG.test(last) ? last : '-'
  }
  const cmd = typeof old.command !== 'string' ? '-' : isLauncher(old) ? carriedCmd(old.command) : b64(old.command)
  const padding = typeof old.padding === 'number' && Number.isFinite(old.padding) ? old.padding : 0
  const interval =
    typeof old.refreshInterval === 'number' && Number.isFinite(old.refreshInterval) && old.refreshInterval > 0
      ? Math.min(INTERVAL_MAX, Math.max(1, old.refreshInterval))
      : INTERVAL_MAX
  return {
    ...prior,
    statusLine: {
      ...old,
      type: 'command',
      command: `${quote(root)}/bin/statusline ${mode} "${STATE_DIR}" ${cmd}`,
      padding,
      refreshInterval: interval,
    },
  }
}

/**
 * Whether the latest whole settings read the hook saw was answered with the launcher. The plugin's own reads
 * never reach its hook (re-entry), so this is the only way the plugin learns what the engine's merge holds.
 */
export const carried = { value: false, seq: 0, seen: false, hooksOff: false }

/** True when the `status_line` option asks for `wrap` or `only`, read as `readMode` reads it. */
export function modeOn(options: Readonly<Obj>): boolean {
  const v = options.status_line
  const mode = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return mode === 'wrap' || mode === 'only'
}

export const register: Register = (on, options) => {
  if (!modeOn(options)) return
  on('settings.read', async ($, e, next) => {
    if (e.source !== undefined) return next(e)
    const seq = ++carried.seq
    let out: Obj | null = null
    let off = false
    try {
      const r = await next(e)
      if ('deny' in r) return r
      off = hooksOff(e.layers, r.value)
      out = answer(e.layers, r.value, $.plugin.root)
      return out === null ? r : { value: out }
    } finally {
      if (seq === carried.seq) {
        carried.value = out !== null
        carried.seen = true
        carried.hooksOff = off
      }
    }
  })
}
