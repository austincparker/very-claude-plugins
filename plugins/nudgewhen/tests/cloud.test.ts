import type { McpConnectResult, McpToolResult, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { MINUTE } from '../hooks/schedule'
import { delayAfter, parsePoll } from '../hooks/cloud'

const SERVER = 'plugin:nudgewhen:nudgewhen'
const HOUR = 60 * MINUTE

type Hosted = { id: string; source: string; text: string; due: number }
type Step = McpConnectResult | 'throw'
type Reply = McpToolResult | 'throw'

const text = (body: unknown): McpToolResult => ({
  content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
  isError: false,
})
const poll = (nudges: unknown[]) => text({ nudges })
const connected: McpConnectResult = { isConnected: true, server: SERVER }
const needsAuth: McpConnectResult = {
  isConnected: false,
  reason: 'auth',
  message: 'The MCP server needs you to sign in; run /mcp to authenticate.',
}

/** The engine beneath the mod, with the hosted server scripted: each connect and call answers from its queue, then repeats its last answer. */
function world(
  on: On,
  now: number,
  script: { connects?: Step[]; polls?: Reply[]; acks?: Reply[] } = {},
  entries: Record<string, unknown> = {},
) {
  const clock = mock.clock(on, { now })
  mock.store(on, entries)
  const shown = {
    toasts: [] as string[],
    notified: [] as { text: string; title?: string }[],
    status: undefined as string | undefined,
    logs: [] as string[],
  }
  const calls = { connects: [] as number[], polls: [] as number[], acks: [] as string[][] }
  const queues = {
    connects: [...(script.connects ?? [connected])],
    polls: [...(script.polls ?? [poll([])])],
    acks: [...(script.acks ?? [])],
  }
  const take = <T>(q: T[], fallback: T): T => (q.length > 1 ? (q.shift() as T) : (q[0] ?? fallback))

  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nudgewhen__${e.name}` } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '|   "HIDIdleTime" = 1000000000\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.toast', (_, e) => {
    shown.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    shown.notified.push({ text: e.text, title: e.title })
    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  on('ui.status', (_, e) => {
    shown.status = e.text
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    shown.logs.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: {} }))
  on('mcp.connect', async () => {
    calls.connects.push(0)
    const step = take<Step>(queues.connects, connected)
    if (step === 'throw') throw new Error('connect exploded')
    return { value: step }
  })
  on('mcp.call', (_, e) => {
    if (e.tool === 'poll_nudges') {
      calls.polls.push(0)
      const r = take<Reply>(queues.polls, poll([]))
      if (r === 'throw') throw new Error('no connected MCP tool "poll_nudges"')
      return { value: r }
    }
    calls.acks.push((e.args.ids as string[]) ?? [])
    const r = take<Reply>(queues.acks, text({ acked: e.args.ids, unknown: [] }))
    if (r === 'throw') throw new Error('no connected MCP tool "ack_nudges"')
    return { value: r }
  })
  return { clock, shown, calls, queues }
}

const start = ($: { session: { start: (a: never) => Promise<unknown> } }) =>
  $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)

const NOW = new Date(2026, 10, 10, 12, 0, 0, 0).getTime()
const hosted = (id: string, source = 'calendar', body = `text ${id}`): Hosted => ({ id, source, text: body, due: NOW })

test('delayAfter: 60s on success, then 1, 2, 4, 8 and a 15 minute cap on failures', () => {
  expect(delayAfter(0)).toBe(MINUTE)
  expect([1, 2, 3, 4, 5, 6, 20].map(delayAfter)).toEqual([1, 2, 4, 8, 15, 15, 15].map(m => m * MINUTE))
})

test('parsePoll keeps well-formed nudges and fails on anything that is not the shape', () => {
  const good = hosted('a')
  expect(parsePoll(poll([good]))).toEqual([good])
  expect(parsePoll(poll([good, { id: 'b' }, null, { ...hosted('c'), due: 'soon' }, 'x']))).toEqual([good])
  expect(parsePoll(poll([]))).toEqual([])
  expect(parsePoll(text('not json'))).toBeNull()
  expect(parsePoll(text({ nope: [] }))).toBeNull()
  expect(parsePoll({ content: [], isError: false })).toBeNull()
  expect(parsePoll({ ...poll([good]), isError: true })).toBeNull()
})

test('the owner session polls at load and every 60 seconds', async ($, on) => {
  const { clock, calls } = world(on, NOW)
  await start($)
  await clock.settle()
  expect(calls.polls.length).toBe(1)

  await clock.advance(59_000)
  expect(calls.polls.length).toBe(1)
  await clock.advance(1_000)
  expect(calls.polls.length).toBe(2)
  await clock.advance(MINUTE)
  expect(calls.polls.length).toBe(3)
  expect(calls.connects.length).toBe(3)
})

test('each hosted nudge shows through toast, notification and status, and the ack carries exactly those ids', async ($, on) => {
  const { clock, shown, calls } = world(on, NOW, {
    polls: [poll([hosted('a', 'calendar', 'call mum'), hosted('b', 'ci', 'deploy is green'), { id: 'bad' }])],
  })
  await start($)
  await clock.settle()

  expect(shown.toasts).toEqual(['nudge (calendar): call mum', 'nudge (ci): deploy is green'])
  expect(shown.notified).toEqual([
    { text: 'call mum', title: 'nudgewhen - calendar' },
    { text: 'deploy is green', title: 'nudgewhen - ci' },
  ])
  expect(shown.status).toMatch(/call mum/)
  expect(shown.status).toMatch(/deploy is green/)
  expect(calls.acks).toEqual([['a', 'b']])
})

test('an ack goes out 100 ids at a time', async ($, on) => {
  const many = Array.from({ length: 150 }, (_, i) => hosted(`n${i}`))
  const { clock, calls } = world(on, NOW, { polls: [poll(many)] })
  await start($)
  await clock.settle()
  expect(calls.acks.map(a => a.length)).toEqual([100, 50])
})

test('not signed in leaves local nudges firing, and the next attempts wait 1, 2, 4, 8 then 15 minutes', async ($, on) => {
  const nudges = [{ id: 1, text: 'tea', due: NOW + 20_000 }]
  const { clock, shown, calls } = world(on, NOW, { connects: [needsAuth] }, { nudges })
  await start($)
  await clock.settle()
  expect(calls.connects.length).toBe(1)
  expect(calls.polls.length).toBe(0)

  await clock.advance(30_000)
  expect(shown.toasts).toEqual(['nudge: tea'])

  let attempts = 1
  for (const m of [1, 2, 4, 8, 15, 15]) {
    const waited = attempts === 1 ? 30_000 : 0
    await clock.advance(m * MINUTE - 15_000 - waited)
    expect(calls.connects.length).toBe(attempts)
    await clock.advance(15_000)
    attempts++
    expect(calls.connects.length).toBe(attempts)
  }
  expect(shown.toasts).toEqual(['nudge: tea'])
})

test('a rejecting poll call is a failure that toasts nothing, then success goes back to 60 seconds', async ($, on) => {
  const { clock, shown, calls } = world(on, NOW, {
    polls: ['throw', 'throw', poll([hosted('a', 'calendar', 'back')]), poll([])],
  })
  await start($)
  await clock.settle()
  expect(calls.connects.length).toBe(1)
  expect(shown.toasts).toEqual([])

  await clock.advance(MINUTE)
  expect(calls.connects.length).toBe(2)
  await clock.advance(2 * MINUTE - 1_000)
  expect(calls.connects.length).toBe(2)
  await clock.advance(1_000)
  expect(calls.connects.length).toBe(3)
  expect(shown.toasts).toEqual(['nudge (calendar): back'])

  await clock.advance(MINUTE)
  expect(calls.connects.length).toBe(4)
})

test('a rejecting connect is a failure too', async ($, on) => {
  const { clock, calls } = world(on, NOW, { connects: ['throw', connected] })
  await start($)
  await clock.settle()
  expect(calls.polls.length).toBe(0)
  await clock.advance(MINUTE)
  expect(calls.polls.length).toBe(1)
})

test('an isError result is a failure with nothing shown', async ($, on) => {
  const failed: McpToolResult = { ...poll([hosted('a')]), isError: true }
  const { clock, shown, calls } = world(on, NOW, { polls: [failed, poll([])] })
  await start($)
  await clock.settle()
  expect(shown.toasts).toEqual([])
  expect(calls.acks).toEqual([])
  await clock.advance(MINUTE - 1_000)
  expect(calls.connects.length).toBe(1)
  await clock.advance(1_000)
  expect(calls.connects.length).toBe(2)
})

test('a malformed poll result is a failure with nothing shown', async ($, on) => {
  const { clock, shown, calls } = world(on, NOW, { polls: [text('<html>502</html>'), poll([])] })
  await start($)
  await clock.settle()
  expect(shown.toasts).toEqual([])
  expect(shown.notified).toEqual([])
  expect(calls.acks).toEqual([])
  await clock.advance(MINUTE)
  expect(calls.connects.length).toBe(2)
})

test('the log gets one line when the connection state changes, naming the reason', async ($, on) => {
  const { clock, shown } = world(on, NOW, { connects: [needsAuth, needsAuth, connected] })
  await start($)
  await clock.settle()
  await clock.advance(MINUTE)
  expect(shown.logs.filter(l => l.includes('auth')).length).toBe(1)
  const before = shown.logs.length
  await clock.advance(2 * MINUTE)
  expect(shown.logs.length).toBe(before + 1)
})

test('a nudge handed back after a failed ack is acked again and not shown twice', async ($, on) => {
  const a = hosted('a', 'calendar', 'call mum')
  const { clock, shown, calls } = world(on, NOW, { polls: [poll([a]), poll([a]), poll([])], acks: ['throw'] })
  await start($)
  await clock.settle()
  expect(shown.toasts.length).toBe(1)
  expect(calls.acks).toEqual([['a']])

  await clock.advance(MINUTE)
  expect(shown.toasts.length).toBe(1)
  expect(shown.notified.length).toBe(1)
  expect(calls.acks).toEqual([['a'], ['a']])
})

test('an id shown in the last hour is not shown again, but is forgotten after it', async ($, on) => {
  const a = hosted('a', 'calendar', 'call mum')
  const { clock, shown } = world(on, NOW, { polls: [poll([a]), poll([a]), poll([a])] })
  await start($)
  await clock.settle()
  await clock.advance(MINUTE)
  expect(shown.toasts.length).toBe(1)
  await clock.advance(HOUR)
  expect(shown.toasts.length).toBe(2)
})

test('a session that is not the owner never polls', async ($, on) => {
  const { clock, calls } = world(on, NOW, {}, { owner: { id: 'session-b', at: NOW + 10 * HOUR } })
  await start($)
  await clock.settle()
  await clock.advance(5 * MINUTE)
  expect(calls.connects.length).toBe(0)
  expect(calls.polls.length).toBe(0)
})
