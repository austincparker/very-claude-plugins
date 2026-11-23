import type { EngineInterface } from 'claude-code'

/** What is counted in one file: settings files count `deny`, `ask` and `hooks`; instruction files count `never`. */
export type Counts = Record<string, number>
/** `scope` is `user` or a project's directory. */
export type Seen = { path: string; label: string; scope: string; counts: Counts }
export type Baseline = Record<string, Counts>

const NEVER_LINE = /\b(never|do not|don't|must not|refuse|forbidden|off limits)\b|\(HARD\)/i

const NOUN: Record<string, [string, string]> = {
  deny: ['a new deny rule', 'new deny rules'],
  ask: ['a new ask rule', 'new ask rules'],
  hooks: ['a new PreToolUse hook', 'new PreToolUse hooks'],
  never: ['a new never-line', 'new never-lines'],
}

/** Lines of `text` that state a rule: a never, a refusal or a (HARD) marker. */
export function countNeverLines(text: string): number {
  return text.split('\n').filter(l => NEVER_LINE.test(l)).length
}

const size = (v: unknown): number => (Array.isArray(v) ? v.length : 0)
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** The deny, ask and PreToolUse hook counts of one settings object. */
export function countSettings(settings: unknown): Counts {
  const s = obj(settings)
  const perms = obj(s.permissions)
  const groups = obj(s.hooks).PreToolUse
  const hooks = Array.isArray(groups)
    ? groups.reduce<number>((n, g) => n + (Array.isArray(obj(g).hooks) ? (obj(g).hooks as unknown[]).filter(h => typeof obj(h).command === 'string').length : 0), 0)
    : 0
  return { deny: size(perms.deny), ask: size(perms.ask), hooks }
}

/** The stored baseline, or an empty one when what is stored is not a map of counts. */
export function readBaseline(v: unknown): Baseline {
  const out: Baseline = {}
  for (const [path, counts] of Object.entries(obj(v))) {
    const c: Counts = {}
    for (const [k, n] of Object.entries(obj(counts))) if (typeof n === 'number' && Number.isFinite(n)) c[k] = n
    out[path] = c
  }
  return out
}

/** The baseline after seeing `seen`, and a phrase for each file whose count grew. The first look at a scope records its files and adds no phrase; after that a file with no baseline counts from zero. */
export function diff(base: Baseline, seen: readonly Seen[], known: ReadonlySet<string>): { next: Baseline; added: string[] } {
  const next: Baseline = { ...base }
  const added: string[] = []
  for (const s of seen) {
    const before = base[s.path] ?? {}
    next[s.path] = s.counts
    if (!known.has(s.scope)) continue
    const parts = Object.entries(s.counts).flatMap(([k, n]) => {
      const grew = n - (before[k] ?? 0)
      const noun = NOUN[k]
      return grew > 0 && noun !== undefined ? [grew === 1 ? noun[0] : `${grew} ${noun[1]}`] : []
    })
    if (parts.length > 0) added.push(`${parts.join(' and ')} in ${s.label}`)
  }
  return { next, added }
}

/** The first change, plus `and N more` when other files grew too. */
export function summarize(added: readonly string[]): string {
  const [first, ...rest] = added
  return rest.length === 0 ? (first ?? '') : `${first} and ${rest.length} more`
}

type Source = 'user' | 'project' | 'local'

/** The files read, with the label shown for each. Project files need `cwd`, user files need `home`. */
function targets(home: string | undefined, cwd: string): { settings: { source: Source; path: string; label: string }[]; files: { path: string; label: string }[]; dirs: { path: string; label: string }[] } {
  const settings: { source: Source; path: string; label: string }[] = []
  const files: { path: string; label: string }[] = []
  const dirs: { path: string; label: string }[] = []
  if (home) {
    settings.push({ source: 'user', path: `${home}/.claude/settings.json`, label: '~/.claude/settings.json' })
    files.push({ path: `${home}/.claude/CLAUDE.md`, label: '~/.claude/CLAUDE.md' })
    dirs.push({ path: `${home}/.claude/rules`, label: '~/.claude/rules' })
  }
  if (cwd.startsWith('/')) {
    const root = cwd.replace(/\/+$/, '')
    settings.push({ source: 'project', path: `${root}/.claude/settings.json`, label: '.claude/settings.json' })
    settings.push({ source: 'local', path: `${root}/.claude/settings.local.json`, label: '.claude/settings.local.json' })
    files.push({ path: `${root}/CLAUDE.md`, label: 'CLAUDE.md' })
    files.push({ path: `${root}/.claude/CLAUDE.md`, label: '.claude/CLAUDE.md' })
    dirs.push({ path: `${root}/.claude/rules`, label: '.claude/rules' })
  }
  return { settings, files, dirs }
}

/** The counts for every readable file in the listed paths. A file the engine cannot read is skipped and `skip` hears about it once. */
export async function scan($: EngineInterface, cwd: string, skip: (path: string, err: unknown, scope: string) => void): Promise<Seen[]> {
  const home = await Promise.resolve($.env.get('HOME')).catch(() => undefined)
  const t = targets(typeof home === 'string' && home.startsWith('/') ? home.replace(/\/+$/, '') : undefined, cwd)
  const out: Seen[] = []
  const have = new Set<string>()
  const add = (s: Seen) => {
    if (have.has(s.path)) return
    have.add(s.path)
    out.push(s)
  }
  const scopeOf = (path: string) => (cwd.startsWith('/') && path.startsWith(`${cwd.replace(/\/+$/, '')}/`) ? cwd.replace(/\/+$/, '') : 'user')
  const instruction = async (path: string, label: string) => {
    try {
      if (!(await $.fs.exists(path))) return
      add({ path, label, scope: scopeOf(path), counts: { never: countNeverLines(await $.fs.read(path)) } })
    } catch (err) {
      skip(path, err, scopeOf(path))
    }
  }
  for (const s of t.settings) {
    try {
      add({ path: s.path, label: s.label, scope: scopeOf(s.path), counts: countSettings(await $.settings.read({ source: s.source })) })
    } catch (err) {
      skip(s.path, err, scopeOf(s.path))
    }
  }
  for (const f of t.files) await instruction(f.path, f.label)
  for (const d of t.dirs) {
    let names: string[] = []
    try {
      if (!(await $.fs.exists(d.path))) continue
      names = (await $.fs.list(d.path)).filter(e => e.name.endsWith('.md') && !/^dir/.test(String(e.kind))).map(e => e.name).sort()
    } catch (err) {
      skip(d.path, err, scopeOf(d.path))
      continue
    }
    for (const name of names) await instruction(`${d.path}/${name}`, `${d.label}/${name}`)
  }
  return out
}
