import { clean } from './cloud'

/** The kinds a line can be for; `any` serves every kind that has no line of its own. */
export const KINDS = ['break', 'reminder', 'ci', 'review', 'landed', 'any'] as const
export type Kind = (typeof KINDS)[number]
export type Line = { kind: Kind; text: string }

export const LINES_MAX = 200
export const LINE_MAX = 200

/** Crude starters, used while the tone is vulgar and the person has no line for the kind or `any`. `{minutes}` and `{text}` are filled in. */
export const STARTER: Record<Kind, readonly string[]> = {
  break: ["You've been at it {minutes}m. Go piss, drink some water, stretch your damn back.", '{minutes} minutes without moving. Get up and shake it out, you magnificent bastard.', 'Break time, {minutes}m in. The code will still be shit when you get back.'],
  reminder: ['Get your shit together, you wanted to hear this: {text}', 'Reminder, you forgetful bastard: {text}', 'Hey, dumbass, remember this? {text}'],
  ci: ['CI shit the bed: {text}', 'Well, fuck. {text}', 'Pipeline says no, and it says it with contempt: {text}'],
  review: ['Somebody wants your damn opinion: {text}', 'Review time, you judgmental bastard: {text}', "Code is waiting for you to be a pedant about it: {text}"],
  landed: ['It landed. Holy shit, it actually landed: {text}', 'Merged. Fuck yeah: {text}', 'Shipped, you beautiful bastard: {text}'],
  any: ['Hey, asshole, heads up: {text}', 'Not to be a dick, but: {text}', 'Pay attention, dammit: {text}'],
}

export type Tone = 'plain' | 'vulgar'

/** `vulgar` only when the setting is exactly that, ignoring case and space; anything else is plain. */
export function readTone(v: unknown): Tone {
  return typeof v === 'string' && v.trim().toLowerCase() === 'vulgar' ? 'vulgar' : 'plain'
}

/** The line kind a hosted source belongs to. */
export function kindForSource(source: string): Kind {
  if (source === 'ci') return 'ci'
  if (source === 'review_requested' || source === 'review_submitted') return 'review'
  if (source === 'pr_landed') return 'landed'
  return 'any'
}

/** `template` with `{minutes}` and `{text}` replaced by the values given; a placeholder with no value stays as written. */
export function fill(template: string, vars: { minutes?: number; text?: string }): string {
  return template
    .replace(/\{minutes\}/g, () => (vars.minutes === undefined ? '{minutes}' : String(vars.minutes)))
    .replace(/\{text\}/g, () => vars.text ?? '{text}')
}

/** `fill`, with the nudge text appended after " - " when the line has no `{text}` and there is text to show. */
export function render(template: string, vars: { minutes?: number; text?: string }): string {
  const line = fill(template, vars)
  return vars.text !== undefined && !template.includes('{text}') ? `${line} - ${vars.text}` : line
}

const isKind = (k: unknown): k is Kind => typeof k === 'string' && (KINDS as readonly string[]).includes(k)

/** `<kind> <text>` as a line, or why it is refused. */
export function parseLine(arg: string): Line | string {
  const m = /^(\S+)\s+([\s\S]+)$/.exec(arg.trim())
  const kind = m?.[1]?.toLowerCase()
  if (kind === 'sit' || kind === 'bed' || kind === 'wake') return 'Sit, bed and wake lines are not kept: those show only in the status line.'
  if (!m || !isKind(kind)) return `Usage: /nudge line add <kind> <text>; kinds: ${KINDS.join(', ')}.`
  const text = clean(m[2] ?? '', LINE_MAX + 1)
  if (text === '') return `Usage: /nudge line add <kind> <text>; kinds: ${KINDS.join(', ')}.`
  if (text.length > LINE_MAX) return `A line is at most ${LINE_MAX} characters.`
  return { kind, text }
}

/** The stored lines that are well formed, at most `LINES_MAX`. */
export function readLines(v: unknown): Line[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((l): l is Line => l !== null && typeof l === 'object' && isKind(l.kind) && typeof l.text === 'string' && l.text !== '')
    .slice(0, LINES_MAX)
    .map(l => ({ kind: l.kind, text: clean(l.text, LINE_MAX) }))
}

const choose = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)] as T

/** A random line for `kind`: the person's own for it, else their `any`, else the starter set for it. */
export function pickLine(lines: readonly Line[], kind: Kind): string {
  const own = lines.filter(l => l.kind === kind)
  if (own.length > 0) return choose(own).text
  const any = lines.filter(l => l.kind === 'any')
  if (any.length > 0) return choose(any).text
  return choose(STARTER[kind])
}
