import { expect, test } from 'claude-code/testing'

import { MINUTE, afterFiring, hourLabel, isBedtime, nextAt, parseWhen, span } from '../hooks/schedule'
import type { When } from '../hooks/schedule'

// Local noon, so clock-time cases hold in any time zone.
const NOON = new Date(2026, 10, 10, 12, 0, 0, 0).getTime()

function at(hour: number, minute: number, dayOffset = 0): number {
  const d = new Date(NOON)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

function when(input: string): When {
  const w = parseWhen(input, NOON)
  if (typeof w === 'string') throw new Error(`refused "${input}": ${w}`)
  return w
}

test('in: durations add up and the text follows', async () => {
  expect(when('in 20m stretch')).toEqual({ due: NOON + 20 * MINUTE, text: 'stretch' })
  expect(when('in 1h30m check the deploy').due).toBe(NOON + 90 * MINUTE)
  expect(when('in 1 hour and 5 minutes call back').due).toBe(NOON + 65 * MINUTE)
  expect(when('in 2 days pay rent').due).toBe(NOON + 2 * 24 * 60 * MINUTE)
  expect(when('in 5 mins to stretch').text).toBe('stretch')
})

test('in: a unit run into a word is not a unit', async () => {
  expect(parseWhen('in 5mo stretch', NOON)).toMatch(/couldn't read how long/)
})

test('a time with no text asks for the text', async () => {
  expect(parseWhen('in 10m', NOON)).toMatch(/What should the nudge say/)
})

test('at: 24-hour and am/pm clocks, today or tomorrow', async () => {
  expect(when('at 17:30 wrap up')).toEqual({ due: at(17, 30), text: 'wrap up' })
  expect(when('at 5pm wrap up').due).toBe(at(17, 0))
  expect(when('at 12am reset').due).toBe(at(0, 0, 1))
  expect(when('at 9:15 standup').due).toBe(at(9, 15, 1))
  expect(parseWhen('at 13pm nope', NOON)).toMatch(/couldn't read the time/)
  expect(parseWhen('at 24:00 nope', NOON)).toMatch(/couldn't read the time/)
})

test('every: repeats, with a one-minute floor', async () => {
  expect(when('every 45m drink water')).toEqual({ due: NOON + 45 * MINUTE, everyMs: 45 * MINUTE, text: 'drink water' })
  expect(parseWhen('every 30s blink', NOON)).toMatch(/at least a minute/)
})

test('every day at: a daily clock time', async () => {
  expect(when('every day at 9:00 standup')).toEqual({ due: at(9, 0, 1), daily: '09:00', text: 'standup' })
  expect(when('daily 13:00 lunch')).toEqual({ due: at(13, 0), daily: '13:00', text: 'lunch' })
})

test('anything else gets the usage', async () => {
  expect(parseWhen('tomorrow maybe', NOON)).toMatch(/^Usage:/)
})

test('afterFiring: a one-shot is gone, a repeat skips what it missed', async () => {
  expect(afterFiring({ id: 1, text: 'x', due: NOON }, NOON)).toEqual([])
  const every = { id: 2, text: 'x', due: NOON, everyMs: 10 * MINUTE }
  expect(afterFiring(every, NOON + 25 * MINUTE)).toEqual([{ ...every, due: NOON + 30 * MINUTE }])
  const daily = { id: 3, text: 'x', due: at(9, 0), daily: '09:00' }
  expect(afterFiring(daily, at(9, 0))).toEqual([{ ...daily, due: at(9, 0, 1) }])
})

test('nextAt is strictly after now', async () => {
  expect(nextAt('12:00', NOON)).toBe(at(12, 0, 1))
  expect(nextAt('12:01', NOON)).toBe(at(12, 1))
})

test('span reads short', async () => {
  expect(span(45_000)).toBe('45s')
  expect(span(20 * MINUTE)).toBe('20m')
  expect(span(65 * MINUTE)).toBe('1h 5m')
  expect(span(60 * MINUTE)).toBe('1h')
  expect(span(51 * 60 * MINUTE)).toBe('2d 3h')
})

test('bedtime wraps past midnight', async () => {
  expect(isBedtime(23, 23, 5)).toBe(true)
  expect(isBedtime(4, 23, 5)).toBe(true)
  expect(isBedtime(5, 23, 5)).toBe(false)
  expect(isBedtime(12, 23, 5)).toBe(false)
  expect(isBedtime(1, 0, 6)).toBe(true)
  expect(isBedtime(7, 0, 6)).toBe(false)
  expect(isBedtime(3, 4, 4)).toBe(false)
  expect([0, 9, 12, 23].map(hourLabel)).toEqual(['midnight', '9am', 'noon', '11pm'])
})
