import { expect, test } from 'claude-code/testing'

import { answer, b64 as encode, carried, readMode, register, segmentFile, stateDir } from '../hooks/statusline'

const ROOT = '/plug ins/nudgewhen'
const STATE = '${CLAUDE_CONFIG_DIR:-$HOME/.claude}/nudgewhen/status'

const cfg = (status_line: unknown, key = 'nudgewhen@very-claude-plugins'): SettingsLayer => ({
  source: 'user',
  settings: { pluginConfigs: { [key]: { options: { status_line } } } },
})
const b64 = (s: string) => encode(s)
type SettingsLayer = Parameters<typeof readMode>[0][number]
const statusLine = (r: Record<string, unknown> | null) => (r as { statusLine: Record<string, unknown> }).statusLine

test('an option missing or off passes through', () => {
  expect(answer([], { a: 1 }, ROOT)).toBeNull()
  expect(answer([{ source: 'user', settings: {} }], { a: 1 }, ROOT)).toBeNull()
  expect(answer([cfg('off')], { a: 1 }, ROOT)).toBeNull()
})

test('an invalid option passes through', () => {
  for (const v of ['wrapx', 1, true, '', null, ['wrap']]) expect(answer([cfg(v)], {}, ROOT)).toBeNull()
})

test('the option is read without regard to case or padding', () => {
  expect(readMode([cfg('Wrap')])).toBe('wrap')
  expect(readMode([cfg(' ONLY ')])).toBe('only')
})

test('disabled hooks pass through', () => {
  const off: SettingsLayer = { source: 'user', settings: { disableAllHooks: true } }
  expect(answer([cfg('wrap'), off], {}, ROOT)).toBeNull()
  expect(answer([cfg('wrap')], { disableAllHooks: true }, ROOT)).toBeNull()
  const managed: SettingsLayer = { source: 'policy', settings: { allowManagedHooksOnly: true } }
  expect(answer([cfg('wrap'), managed], {}, ROOT)).toBeNull()
  const notManaged: SettingsLayer = { source: 'user', settings: { allowManagedHooksOnly: true } }
  expect(answer([cfg('wrap'), notManaged], {}, ROOT)).not.toBeNull()
})

test('only the plugin own keys count', () => {
  expect(readMode([cfg('wrap', 'nudgewhen')])).toBe('wrap')
  expect(readMode([cfg('wrap', 'nudgewhen@x')])).toBe('wrap')
  expect(readMode([cfg('wrap', 'nudgewhenx')])).toBeNull()
  expect(readMode([cfg('wrap', 'other@x')])).toBeNull()
})

test('the highest-precedence layer wins', () => {
  expect(readMode([cfg('wrap'), cfg('only')])).toBe('only')
  expect(readMode([cfg('only'), cfg('off')])).toBeNull()
  expect(readMode([cfg('wrap'), { source: 'project', settings: {} }])).toBe('wrap')
})

test('a policy layer holding statusLine passes through', () => {
  const policy: SettingsLayer = { source: 'policy', settings: { statusLine: { type: 'command', command: 'x' } } }
  expect(answer([cfg('wrap'), policy], {}, ROOT)).toBeNull()
  const other: SettingsLayer = { source: 'policy', settings: { model: 'x' } }
  expect(answer([cfg('wrap'), other], {}, ROOT)).not.toBeNull()
})

test('wrap keeps every prior key and sets statusLine', () => {
  const prior = { model: 'm', env: { A: '1' }, statusLine: { type: 'command', command: 'old', extra: 1 } }
  const r = answer([cfg('wrap')], prior, ROOT)!
  expect(r.model).toBe('m')
  expect(r.env).toEqual({ A: '1' })
  expect(statusLine(r)).toEqual({
    type: 'command',
    command: `'${ROOT}'/bin/statusline wrap "${STATE}" ${b64('old')}`,
    extra: 1,
    padding: 0,
    refreshInterval: 30,
  })
})

test('a prior statusLine key the launcher does not set is kept', () => {
  const r = answer([cfg('wrap')], { statusLine: { type: 'command', command: 'old', hideVimModeIndicator: true } }, ROOT)
  expect(statusLine(r).hideVimModeIndicator).toBe(true)
})

test('a launcher statusLine hands on only a base64 or dash prior, never shell text', () => {
  const launcher = (tail: string) => ({ statusLine: { command: `'/old'/bin/statusline wrap "${STATE}" ${tail}` } })
  expect(statusLine(answer([cfg('only')], launcher(b64('old')), ROOT)).command).toBe(`'${ROOT}'/bin/statusline only "${STATE}" ${b64('old')}`)
  expect(statusLine(answer([cfg('only')], launcher('-'), ROOT)).command).toBe(`'${ROOT}'/bin/statusline only "${STATE}" -`)
  for (const bad of ['$(touch x)', ';touch', '`id`', 'a|b', "'x'"]) {
    expect(statusLine(answer([cfg('only')], launcher(bad), ROOT)).command).toBe(`'${ROOT}'/bin/statusline only "${STATE}" -`)
  }
})

test('only mode still passes the prior command', () => {
  const r = answer([cfg('only')], { statusLine: { command: 'old' } }, ROOT)
  expect(statusLine(r).command).toBe(`'${ROOT}'/bin/statusline only "${STATE}" ${b64('old')}`)
})

test('no prior statusLine gives -, padding 0 and interval 30', () => {
  const r = answer([cfg('wrap')], {}, ROOT)
  expect(statusLine(r)).toMatchObject({ command: `'${ROOT}'/bin/statusline wrap "${STATE}" -`, padding: 0, refreshInterval: 30 })
})

test('the interval is capped at 30 and a lower one stays', () => {
  expect(statusLine(answer([cfg('wrap')], { statusLine: { refreshInterval: 120 } }, ROOT)).refreshInterval).toBe(30)
  expect(statusLine(answer([cfg('wrap')], { statusLine: { refreshInterval: 10 } }, ROOT)).refreshInterval).toBe(10)
})

test('a prior padding is kept', () => {
  expect(statusLine(answer([cfg('wrap')], { statusLine: { command: 'c', padding: 2 } }, ROOT)).padding).toBe(2)
})

test('the base64 decodes to the prior command with its quotes', () => {
  const old = `echo "it's" | jq '.a'`
  const cmd = String(statusLine(answer([cfg('wrap')], { statusLine: { command: old } }, ROOT)).command)
  const enc = cmd.split(' ').pop()!
  expect(atob(enc)).toBe(Array.from(new TextEncoder().encode(old), c => String.fromCharCode(c)).join(''))
})

test('a root with a quote is escaped for the shell', () => {
  const cmd = String(statusLine(answer([cfg('wrap')], {}, "/a'b")).command)
  expect(cmd.startsWith(`'/a'\\''b'/bin/statusline wrap `)).toBe(true)
})

test('an interval below 1 is raised to 1 second', () => {
  for (const [v, want] of [[0.5, 1], [0.001, 1], [2.5, 2.5]] as const) {
    expect(statusLine(answer([cfg('wrap')], { statusLine: { refreshInterval: v } }, ROOT)).refreshInterval).toBe(want)
  }
})

test('the same layers give the same answer', () => {
  const layers = [cfg('wrap')]
  const prior = { statusLine: { command: 'old', refreshInterval: 60 } }
  expect(answer(layers, prior, ROOT)).toEqual(answer(layers, prior, ROOT))
})

/** The `settings.read` handler the module registers, called with a stub engine. */
function hook() {
  let h: (($: unknown, e: unknown, next: (e: unknown) => unknown) => Promise<unknown>) | undefined
  register(((name: string, fn: typeof h) => {
    if (name === 'settings.read') h = fn
  }) as never, {})
  return (e: unknown, next: (e: unknown) => unknown) => h!({ plugin: { root: ROOT } }, e, next)
}

test('the hook answers a whole read with the rewritten settings', async () => {
  const r = (await hook()({ layers: [cfg('wrap')] }, () => ({ value: { model: 'm' } }))) as { value: Record<string, unknown> }
  expect(r.value.model).toBe('m')
  expect(statusLine(r.value).command).toBe(`'${ROOT}'/bin/statusline wrap "${STATE}" -`)
})

test('the hook passes a read of one source, a deny and an empty layer list through', async () => {
  const run = hook()
  const next = () => ({ value: { model: 'm' } })
  expect(await run({ source: 'user', layers: [cfg('wrap')] }, next)).toEqual({ value: { model: 'm' } })
  expect(await run({ layers: [cfg('wrap')] }, () => ({ deny: 'no' }))).toEqual({ deny: 'no' })
  expect(await run({ layers: [] }, next)).toEqual({ value: { model: 'm' } })
})

test('the hook sets carried true for a whole read with status_line wrap', async () => {
  carried.value = false
  await hook()({ layers: [cfg('wrap')] }, () => ({ value: {} }))
  expect(carried.value).toBe(true)
})

test('the hook sets carried false when the policy layer holds statusLine', async () => {
  carried.value = true
  const policy: SettingsLayer = { source: 'policy', settings: { statusLine: { type: 'command', command: 'x' } } }
  await hook()({ layers: [cfg('wrap'), policy] }, () => ({ value: {} }))
  expect(carried.value).toBe(false)
})

test('the hook records a whole read and whether hooks are off', async () => {
  carried.seen = false
  await hook()({ layers: [cfg('wrap')] }, () => ({ value: { disableAllHooks: true } }))
  expect(carried.seen).toBe(true)
  expect(carried.hooksOff).toBe(true)
  await hook()({ layers: [cfg('wrap')] }, () => ({ value: {} }))
  expect(carried.hooksOff).toBe(false)
})

test('a read of one source leaves carried alone', async () => {
  carried.value = true
  await hook()({ source: 'user', layers: [] }, () => ({ value: {} }))
  expect(carried.value).toBe(true)
  carried.value = false
  await hook()({ source: 'user', layers: [cfg('wrap')] }, () => ({ value: {} }))
  expect(carried.value).toBe(false)
})

test('a denied or failed whole read sets carried false', async () => {
  const rows: (() => unknown)[] = [
    () => ({ deny: 'no' }),
    () => {
      throw new Error('x')
    },
  ]
  for (const next of rows) {
    carried.value = true
    await hook()({ layers: [cfg('wrap')] }, next).catch(() => undefined)
    expect(carried.value).toBe(false)
  }
})

test('the segment file is the header, the list, then one tab row per segment with text', () => {
  const rows: [string, string][] = [['breaks', 'breaks 0'], ['dir', ''], ['nudge', 'a\tb\nc']]
  expect(segmentFile(1000, 'breaks,dir,nudge', rows)).toBe('v1 1000\nbreaks,dir,nudge\nbreaks\tbreaks 0\nnudge\ta b c\n')
})

test('the state dir is under CLAUDE_CONFIG_DIR, else HOME, else none', () => {
  expect(stateDir('/cfg', '/h')).toBe('/cfg/nudgewhen/status')
  expect(stateDir('', '/h')).toBe('/h/.claude/nudgewhen/status')
  expect(stateDir(undefined, undefined)).toBe(null)
})

test('a statusLine that already runs the launcher is not wrapped again', () => {
  const first = answer([cfg('wrap')], { statusLine: { type: 'command', command: 'echo hi' } }, ROOT)!
  const second = answer([cfg('wrap')], first, ROOT)!
  expect((second.statusLine as { command: string }).command).toBe((first.statusLine as { command: string }).command)
})

test('control characters in a row cannot reach the terminal', () => {
  expect(segmentFile(1, 'a', [['n', 'x\u001b[31my\u009bz']])).toBe('v1 1\na\nn\tx [31my z\n')
})

test('tabs and newlines in the list and names cannot add rows', () => {
  expect(segmentFile(1, 'a\nx\tb', [['n\tm', 't']])).toBe('v1 1\na x b\nn m\tt\n')
})
