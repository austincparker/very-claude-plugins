# nudgewhen

Nudges inside Claude Code: take a break, go to bed, and any reminder you set.

- **Break nudges.** The status line counts how long you've been at the keyboard and says `stand up` at twice your limit. Launching an agent after a long sit pops a toast: the agent has this, go walk.
- **Bedtime.** Past your bedtime the status line says it's time to wrap up.
- **Your own nudges.** `/nudge in 20m check the deploy`, or ask Claude: "remind me at 5pm to send the invoice." Due nudges show as a toast, in the status line and as a terminal notification (a desktop banner in terminals that send one).
- **Idle nudge.** A session left holding background work can ask itself whether it needs to stay open, and hand off what a script can finish. Off by default.

## Install

```
/plugin install nudgewhen --marketplace austincparker/very-claude-plugins
```

## Use

| Command | Does |
| --- | --- |
| `/nudge in 20m <text>` | one nudge, 20 minutes from now (`45s`, `1h30m`, `2 days` work too) |
| `/nudge at 17:30 <text>` | one nudge at a clock time (`5pm` works) |
| `/nudge every 45m <text>` | a repeating nudge |
| `/nudge every day at 9:00 <text>` | a daily nudge |
| `/nudge every weekday at 9:00 <text>` | a nudge on Monday to Friday |
| `/nudge every mon,wed,fri at 9:00 <text>` | a nudge on the days you list |
| `/nudge list` | your nudges and how long you've sat |
| `/nudge cancel <id>` / `cancel all` | drop nudges |
| `/nudge report` | breaks and sits, per day |
| `/nudge forget` | clear the sitting log and fired-nudge text |
| `/nudge snooze 30m` | hold every toast and notification for 30 minutes (`2h`, `1h30m` work too) |
| `/nudge pause` / `pause until 14:30` / `pause tomorrow` | hold until `/nudge resume`, until that time, or until your wake-up time tomorrow |
| `/nudge resume` | end a snooze or pause |

Claude gets a `nudge` tool that sets, lists and cancels nudges one at a time, so plain requests work. Cancelling all of them takes your own `/nudge cancel all`. Nudge text is cut to 200 characters with control characters removed, and you can keep up to 100 nudges.

## Settings

Install asks for these; change them later in `/config`. **Nudge sessions when idle?** takes effect when the next session starts.

| Setting | Default | Meaning |
| --- | --- | --- |
| Break nudge after (minutes) | 30 | sitting time before the break nudge |
| A break is (minutes) with no input | 5 | idle time that counts as a break |
| Bedtime nudge | on | show the wrap-up nudge |
| Bedtime (`bedtime`) | 23:00 | when the wrap-up nudge starts |
| Wake-up (`wake`) | 05:00 | when it ends |
| Work hours (`work_hours`) | empty | `HH:MM-HH:MM`; break nudges only run inside it |
| Work days (`work_days`) | empty | `mon,tue,...`; break nudges only run on these days |
| Quiet hours (`quiet_hours`) | empty | `HH:MM-HH:MM`; no toasts or notifications, the status line still shows |
| Tone (`tone`) | `plain` | `plain` or `vulgar` wording for toasts and notifications |
| Ghostty titles (`titles`) | on | `on` sets the Ghostty tab and window titles at session start (only when a role, a set or a stored title exists); `off` leaves them alone |
| Status line segments (`status_segments`) | `sit,bed,hosted` | what the status line shows, in order |
| Nudge sessions when idle? (`idle_nudge`) | off | run the idle check when a session sits idle holding background work |
| Status line (`status_line`) | off | `off`, `wrap` or `only`; see Status line replacement |

An invalid time, range or day list falls back to its default and a toast says so once. Empty means always (work hours, work days) or none (quiet hours). Times are 24-hour and local; ranges may cross midnight.

A snooze, a pause and quiet hours each hold every toast and notification, hosted nudges included. A reminder that came due while held fires once when the hold ends.

Each of these has a command that checks the value and saves it:

| Command | Sets |
| --- | --- |
| `/nudge bedtime 22:30` | `bedtime` |
| `/nudge wake 06:00` | `wake` |
| `/nudge hours 09:00-17:00` | `work_hours` (no argument clears it) |
| `/nudge days mon,tue,wed,thu,fri` | `work_days` (no argument clears it) |
| `/nudge quiet 12:00-13:00` | `quiet_hours` (no argument clears it) |
| `/nudge status model,cost,branch` | `status_segments` (no argument lists the current ones and every name) |
| `/nudge statusline wrap` | `status_line` (`wrap`, `only` or `off`; no argument says whether it is on) |
| `/nudge tone vulgar` | `tone` |

## Tone

The `tone` setting is `plain` (the default, every text as it is) or `vulgar`. Under `vulgar`, each toast and notification says a random line for its kind, drawn from your own lines or, when you have none for it, a short crude starter set. Set it in `/config` or with `/nudge tone plain` or `/nudge tone vulgar`.

Add your own lines with `/nudge line add <kind> <text>`, see them with `/nudge line list [kind]` and remove one with `/nudge line rm <n>` (the number from the full list). You can keep up to 200 lines of up to 200 characters each. A kind with no line of yours uses your `any` lines, then the starters; `rules` skips `any` and uses only its own lines, then its starter.

| Kind | Used for | Example line |
| --- | --- | --- |
| `break` | the break toast when an agent launches | `{minutes} minutes on your ass. Stand up.` |
| `reminder` | your own `/nudge in`, `at` and `every` reminders | `Remember this, you forgetful bastard: {text}` |
| `ci` | hosted CI nudges | `Pipeline shit the bed: {text}` |
| `review` | hosted review requests and reviews | `Somebody wants your damn opinion: {text}` |
| `landed` | hosted pull request landed nudges | `Merged. Fuck yeah: {text}` |
| `rules` | a toast, under `vulgar` only, when a file you keep rules in grew (see below) | `Quit being such a bitch: {text}` |
| `any` | any kind with no line of its own | `Not to be a dick, but: {text}` |

The `rules` line fires when something that makes Claude's work harder is added: more entries in `permissions.deny` or `permissions.ask`, or more `PreToolUse` hook commands, in `~/.claude/settings.json`, `.claude/settings.json` or `.claude/settings.local.json`; or more lines saying never, do not, don't, must not, refuse, forbidden, off limits or (HARD) in `~/.claude/CLAUDE.md`, `~/.claude/rules/*.md`, `CLAUDE.md`, `.claude/CLAUDE.md` or `.claude/rules/*.md`. Its `{text}` says what grew, such as `2 new deny rules in ~/.claude/settings.json`. nudgewhen remembers each file's count, so the first look at a file and any drop show nothing, and a change seen under the `plain` tone, a pause, a snooze or quiet hours is never shown later. It shows now and then, not on every change: a change wins a one-in-three roll, and no `rules` toast follows within 12 hours of the last. It reads only those files.

`{minutes}` is how long you have been sitting (in `break` lines) and `{text}` is the nudge's own text. A line with no `{text}` gets the nudge text added after ` - `. Sit, bed and wake lines are not kept: those show only in the status line.

Under `vulgar`, about one line in four ends in ", you fat lard." (", you fat lard?" when it asks a question) in place of its own ending.

The status entry, `/nudge list` and the setup hints stay plain whatever the tone. Your lines stay on your machine and are never sent to the hosted server.

## Titles

The `titles` setting defaults to `on`, so in Ghostty on macOS a new install rewrites your tab and window titles at session start; set `titles` to `off` (or `/nudge title off`) to keep your own. nudgewhen sets the tab title to the session's role and the window title to the working set's name. It reads `NUDGEWHEN_ROLE` and `NUDGEWHEN_SET` at session start, or what `/nudge title` stored for the session. Nothing is sent to the hosted server.

| Command | Does |
| --- | --- |
| `/nudge title` | shows the current titles |
| `/nudge title role <text>` | sets the tab title |
| `/nudge title set <text>` | sets the window title |
| `/nudge title clear` | clears both, and the environment values no longer apply to this session |
| `/nudge title on` or `off` | the `titles` setting (default `on`) |

A title is at most 60 characters, control characters removed. Outside Ghostty, or with no tty, nothing runs. With no `NUDGEWHEN_ROLE`, `NUDGEWHEN_SET` or stored title, nothing is rewritten.

## Hosted controls

The plugin ships a connection to the hosted server at `https://nudgewhen.dev/mcp`, a third-party service. Sign in with `/mcp` to turn it on; until you do, the hosted poll stays off and local nudges run as usual. The server's own tools, which Claude Code lists once you sign in, are separate from the local `nudge` tool above: that one only sets, lists and cancels your local nudges. Text from the server (a nudge's source and body, and your preferences) is untrusted: control, bidi and zero-width characters are replaced with spaces and the text is cut to length before it reaches a toast, a notification, the status line or the stored fired-nudge text, the same way local nudge text is. These controls change what the server sends you. Signed out, each answers with a one-line sign-in hint (`/mcp`).

| Command | Does |
| --- | --- |
| `/nudge prefs` | shows your hosted preferences |
| `/nudge mute owner/repo` | stops nudges from a repository |
| `/nudge unmute owner/repo` | turns them back on |
| `/nudge failures-only on` | CI nudges only for failures (`off` undoes it) |
| `/nudge kinds ci,pr_landed` | which kinds you get: `ci`, `review_requested`, `review_submitted`, `pr_landed` |

`/nudge snooze`, `/nudge quiet`, `/nudge pause` and `/nudge resume` also update the server when you are signed in, sending the hold's end time (or none), your quiet hours and your IANA time zone to nudgewhen.dev. There is no separate opt-out: stay signed out of the server (`/mcp`) and nudgewhen sends it nothing. A pause with no end is sent as a far-future time. A command waits at most 3 seconds for the server; a slower sync finishes in the background and a failure shows as a toast.

## What goes to nudgewhen.dev

Until you sign in with `/mcp`, the hosted poll stays off and nudgewhen sends the server nothing. Claude Code itself still contacts `https://nudgewhen.dev/mcp` at session start, without credentials, to learn that sign-in is needed, so the server can see your IP address and Claude Code's version.

Signed in, nudgewhen sends only this:

| When | What it sends |
| --- | --- |
| About once a minute, from one open interactive session, unless a snooze, pause or quiet hours hold nudges | a request for new hosted nudges, then the ids of the ones it received, to mark them delivered |
| Every 5 minutes, from each open interactive session | a request for the status the `hosted`, `ci` and `reviews` segments show |
| `/nudge prefs`, `mute`, `unmute` | a request for your hosted preferences; `mute` and `unmute` then send your whole list of muted `owner/repo` names |
| `/nudge failures-only`, `/nudge kinds` | the on or off setting, or the list of kinds |
| `/nudge snooze`, `pause`, `resume` | the hold's end time (none for `resume`, a far-future time for a pause with no end) and your IANA time zone |
| `/nudge quiet` | your quiet hours (empty when cleared) and your IANA time zone |

Your nudges, sitting log, tone lines, titles, work hours, work days, bedtime and wake-up stay on your machine. Once you are signed in, Claude Code also lists the server's own tools to Claude, which can call them in a conversation like any MCP tool.

## Status line

`status_segments` is a comma list. Segments show in the order you give, separated by `·`. A segment with nothing to show drops out, and a name that is not on the list is skipped.

| Segment | Shows | Comes from |
| --- | --- | --- |
| `sit` | `sat 42m`, then `stand up` at twice your limit, once you pass the limit | the sitting reading |
| `break` | `break in 12m`, the time left before the break nudge | the sitting reading |
| `next` | `next 17:30 <text>`, your soonest nudge | your nudges |
| `bed` | `bed in 1h 30m` in the last two hours, then `past 11pm · time to wrap up` | the bedtime and wake-up settings |
| `breaks` | `breaks 3`, breaks taken today | the sitting log |
| `context` | `ctx 42%`, how full the context window is | the session's usage |
| `limits` | `5h 82%`, the rate limit closest to its cap | the session's usage |
| `cost` | `$1.23`, what the session has cost | the session's usage |
| `model` | the model in use | the session |
| `branch` | the git branch, blank outside a repository | `git branch --show-current`, looked up once a minute |
| `hosted` | `hosted 2 pending`, `hosted paused`, `hosted quiet` or `hosted ok` | the hosted server, read every 5 minutes; blank until you sign in |
| `ci` | the newest CI nudge | the hosted server; blank until you sign in |
| `reviews` | the newest review nudge | the hosted server; blank until you sign in |

`break` and `sit` only show inside your work hours and work days. Nudges that just fired show first, ahead of the segments.

What a mod cannot read, so only a `statusLine` command can show it:

- fast mode
- the PR badge
- vim mode

With `status_line` on, nudgewhen's own `statusLine` command shows them as the `fast`, `pr` and `vim` segments (see below).

## Status line replacement

`/nudge statusline wrap` or `/nudge statusline only` makes nudgewhen draw a row of Claude Code's own status line. `/nudge statusline off` turns it off, which is the default. `/nudge statusline` with no argument says whether it is on.

- `wrap` runs your own `statusLine` command first, with the same input, and prints its rows above the nudgewhen row. Your command gets 1 second. If it fails or runs over, its last good output shows instead. With no `statusLine` of your own, `wrap` acts like `only`.
- `only` shows just the nudgewhen row.

The row follows `status_segments`, so add the names below to it, for example `/nudge status sit,bed,effort,pr,dir`. They come from the input Claude Code sends the status line. With `status_line` off they stay blank.

| Segment | Shows |
| --- | --- |
| `effort` | `effort <level>`, the reasoning effort |
| `fast` | `fast`, when fast mode is on |
| `vim` | `vim <mode>` |
| `pr` | `PR #12` and its review state, or `MR !12` for a merge request |
| `style` | the output style, blank for the default |
| `worktree` | the worktree name |
| `dir` | the last part of the working directory |
| `lines` | `+120 -14`, lines added and removed, blank at zero |

These eight need `jq` on your PATH and stay blank without it. The other segments don't need it. The launcher hides its errors and always exits 0.

nudgewhen writes no settings file. It changes the `statusLine` value Claude Code reads while the plugin is loaded. Disable or uninstall the plugin and your own status line is back.

- Your `padding` is kept.
- The line refreshes at least every 30 seconds. A shorter `refreshInterval` of yours is kept, at least 1 second.
- The row lives in one file per session under `~/.claude/nudgewhen/status` (or `$CLAUDE_CONFIG_DIR/nudgewhen/status`), removed when the session ends.
- If the file goes two minutes without an update, the row drops out.

It works in the terminal only. On other surfaces the nudgewhen status entry shows as before.

A `statusLine` set by managed policy is never replaced. Some machines load Claude Code's built-in guard: those with managed settings, a `managed-mcp.json`, or a Team or Enterprise login. There the guard can skip the replacement for a plugin you installed yourself or loaded with `--plugin-dir`. Your own status line then stays, and the debug log says `settings.read bypassed by cc-plugin-sec-default`.

## How it knows you're sitting

On macOS it reads the system idle time (`ioreg`), on Linux `xprintidle` when installed, and otherwise the time since your last prompt. Five minutes with no keyboard or mouse input counts as a break. Nothing else leaves your machine: [What goes to nudgewhen.dev](#what-goes-to-nudgewhendev) lists what the hosted server gets. Locally, some data is written down in Claude Code's plugin store: your nudges, the text of nudges that fired in the last ten minutes, and a sitting log (one row per sit and per break, minute resolution, kept 90 days and at most 5000 rows). `/nudge forget` clears the log and the fired-nudge text. A gap with no session open counts as a break, so hours of work with Claude Code closed read as one.

Nudges fire while a Claude Code session is open. One that came due while none was open fires at the next session, marked late.

## Nudge skills

The idle nudge runs a skill named `idle-nudge`. A skill of your own with that name (source `user`) runs instead of the plugin's `nudgewhen:idle-nudge`.

## Idle nudge

The `nudgewhen:idle-nudge` skill asks whether the session truly needs to sit idle. It lists what the session waits on, hands off to a detached script or job whatever needs no judgment, and ends with one line saying the session can close, or one `Needs me` line per wait that still needs it, each followed by up to four short sentences. Run it by hand anytime.

Turn on **Nudge sessions when idle?** and nudgewhen runs it for you. When Claude ends a turn still holding waits and you send no prompt for two minutes, it runs the nudge. Waits are background shells, agents, workflows, monitors Claude started, and scheduled wake-ups. It runs once per wait: the same waits never trigger it twice, a new one does. A draft in your prompt box holds it off a minute at a time, for up to five minutes. Nudge skills says which skill runs.

It needs plugin hooks turned on, since it reads Claude Code's own end-of-turn report of background work; with hooks off it finds no report and does nothing. The report goes to a private temporary directory made for the session and is deleted when the session ends. With the setting off, the plugin's Stop hook still starts a shell at the end of each turn, and the shell exits at once without writing anything. The idle nudge runs a turn, which uses your usage, so the setting is off by default.

## Development

`claude plugin test plugins/nudgewhen` runs the unit tests. It cannot start processes, so run `sh plugins/nudgewhen/tests/stop-hook.sh` as well to check the Stop hook command in `hooks/hooks.json`. `sh plugins/nudgewhen/tests/statusline-launcher.sh` tests the status line launcher the same way.

## License

MIT
