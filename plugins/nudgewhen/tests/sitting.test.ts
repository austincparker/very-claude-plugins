import { expect, test } from 'claude-code/testing'

import { MINUTE } from '../hooks/schedule'
import { STALE_MS, isSampler, localStamp, readSit, report, satMinutes, step } from '../hooks/sitting'
import type { Sit } from '../hooks/sitting'

const T = new Date(2026, 10, 10, 9, 0, 0, 0).getTime()
const AWAY = 5 * MINUTE
const EMPTY: Sit = { sitStart: null, awayStart: null, updated: 0 }

test('input starts a sit at the last keypress', async () => {
  const { sit, log } = step(EMPTY, 2000, T, AWAY)
  expect(sit).toEqual({ sitStart: T - 2000, awayStart: null, updated: T })
  expect(log).toEqual([])
})

test('a long idle ends the sit where the idle began, and input ends the break', async () => {
  const sitting = step(EMPTY, 0, T, AWAY).sit
  const away = step(sitting, 6 * MINUTE, T + 46 * MINUTE, AWAY)
  expect(away.sit.sitStart).toBe(null)
  expect(away.sit.awayStart).toBe(T + 40 * MINUTE)
  expect(away.log).toEqual([[localStamp(T), 'sit', 40]])

  const back = step(away.sit, 0, T + 52 * MINUTE, AWAY)
  expect(back.sit.sitStart).toBe(T + 52 * MINUTE)
  expect(back.log).toEqual([[localStamp(T + 40 * MINUTE), 'break', 12]])
})

test('a gap with no samples counts as a break from the last sample', async () => {
  const sitting = step(EMPTY, 0, T, AWAY).sit
  const later = T + STALE_MS + MINUTE
  const { sit, log } = step(sitting, 0, later, AWAY)
  expect(log).toEqual([
    [localStamp(T), 'sit', 0],
    [localStamp(T), 'break', 4],
  ])
  expect(sit.sitStart).toBe(later)
})

test('satMinutes reads nothing from a stale sample', async () => {
  const sit = { sitStart: T, awayStart: null, updated: T + 30 * MINUTE }
  expect(satMinutes(sit, T + 31 * MINUTE)).toBe(31)
  expect(satMinutes(sit, T + 30 * MINUTE + STALE_MS + 1)).toBe(null)
})

test('one session samples; another takes over once it goes quiet', async () => {
  const sit = { ...EMPTY, updated: T, sampler: 'a' }
  expect(isSampler(sit, 'a', T + 10_000)).toBe(true)
  expect(isSampler(sit, 'b', T + 60_000)).toBe(false)
  expect(isSampler(sit, 'b', T + 91_000)).toBe(true)
})

test('readSit survives whatever the store holds', async () => {
  expect(readSit(undefined)).toEqual({ sitStart: null, awayStart: null, updated: 0, sampler: undefined })
  expect(readSit({ sitStart: 'x', updated: 5 })).toEqual({ sitStart: null, awayStart: null, updated: 5, sampler: undefined })
})

test('report sums each day', async () => {
  expect(report([])).toMatch(/No sitting log yet/)
  const out = report([
    ['2026-11-10T09:00', 'sit', 40],
    ['2026-11-10T09:40', 'break', 12],
    ['2026-11-10T09:52', 'sit', 20],
    ['2026-11-09T22:00', 'sit', 90],
  ]).split('\n')
  expect(out[1]).toMatch(/^2026-11-09\s+0\s+90m\s+90m$/)
  expect(out[2]).toMatch(/^2026-11-10\s+1\s+40m\s+30m$/)
})
