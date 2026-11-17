export const TITLE_MAX = 60
export const TITLES_MAX = 50

export const TITLE_USAGE = 'Usage: /nudge title role <text> | title set <text> | title clear | title on|off; bare /nudge title shows the current values.'

export type TitleArgs = { role: string } | { set: string } | { clear: true } | { on: true } | { off: true } | { show: true }

/** `s` without control characters, trimmed, at most 60 characters. */
export function cleanTitle(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, TITLE_MAX)
}

/** Titles are off for `off`, `false`, `no` or `0` in any case and padding, or a boolean false. */
export function readTitlesOn(v: unknown): boolean {
  if (v === false) return false
  return !['off', 'false', 'no', '0'].includes(String(v ?? '').trim().toLowerCase())
}

/** What `/nudge title <arg>` asks for, or the usage line when it is not understood. */
export function parseTitleArgs(arg: string): TitleArgs | string {
  const a = arg.trim()
  if (a === '') return { show: true }
  const m = /^(role|set)\s+([\s\S]+)$/i.exec(a)
  if (m) {
    const text = cleanTitle(m[2] ?? '')
    if (text === '') return TITLE_USAGE
    return (m[1] ?? '').toLowerCase() === 'role' ? { role: text } : { set: text }
  }
  const v = a.toLowerCase()
  if (v === 'clear') return { clear: true }
  if (v === 'on') return { on: true }
  if (v === 'off') return { off: true }
  return TITLE_USAGE
}

export function isGhostty(termProgram: string | undefined): boolean {
  return termProgram === 'ghostty'
}

/** `/dev/ttysNNN` from `ps -o tty=` output; null for `??`, empty or anything that is not a tty name. */
export function ttyPath(psOut: string | null | undefined): string | null {
  const m = /^\s*(ttys\d+)\s*$/.exec(psOut ?? '')
  return m ? `/dev/${m[1]}` : null
}

/** JXA taking argv [tty, role, set]: sets the matching terminal's tab and window title overrides; an empty string clears. */
export const TITLE_JS = `function run(argv) {
  var app = Application('Ghostty')
  var wins = app.windows()
  for (var i = 0; i < wins.length; i++) {
    var tabs = wins[i].tabs()
    for (var j = 0; j < tabs.length; j++) {
      var terms = tabs[j].terminals()
      for (var k = 0; k < terms.length; k++) {
        if (terms[k].tty() === argv[0]) {
          tabs[j].nameOverride = argv[1]
          terms[k].nameOverride = argv[2]
          return 'ok'
        }
      }
    }
  }
  throw new Error('no terminal on ' + argv[0])
}`

/** The command that applies the titles; the values travel as arguments, never inside the script. */
export function titleArgv(tty: string, role: string, set: string): string[] {
  return ['osascript', '-l', 'JavaScript', '-e', TITLE_JS, tty, role, set]
}
