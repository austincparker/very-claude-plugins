import { expect, test } from 'claude-code/testing'

import { answer, b64 as encode, readMode, register } from '../hooks/statusline'

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
  for (const v of ['WRAP', 1, true, '', null, ['wrap']]) expect(answer([cfg(v)], {}, ROOT)).toBeNull()
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
    command: `'${ROOT}'/bin/statusline wrap ${STATE} ${b64('old')}`,
    padding: 0,
    refreshInterval: 30,
  })
})

test('only mode still passes the prior command', () => {
  const r = answer([cfg('only')], { statusLine: { command: 'old' } }, ROOT)
  expect(statusLine(r).command).toBe(`'${ROOT}'/bin/statusline only ${STATE} ${b64('old')}`)
})

test('no prior statusLine gives -, padding 0 and interval 30', () => {
  const r = answer([cfg('wrap')], {}, ROOT)
  expect(statusLine(r)).toMatchObject({ command: `'${ROOT}'/bin/statusline wrap ${STATE} -`, padding: 0, refreshInterval: 30 })
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
  expect(statusLine(r.value).command).toBe(`'${ROOT}'/bin/statusline wrap ${STATE} -`)
})

test('the hook passes a read of one source, a deny and an empty layer list through', async () => {
  const run = hook()
  const next = () => ({ value: { model: 'm' } })
  expect(await run({ source: 'user', layers: [cfg('wrap')] }, next)).toEqual({ value: { model: 'm' } })
  expect(await run({ layers: [cfg('wrap')] }, () => ({ deny: 'no' }))).toEqual({ deny: 'no' })
  expect(await run({ layers: [] }, next)).toEqual({ value: { model: 'm' } })
})
