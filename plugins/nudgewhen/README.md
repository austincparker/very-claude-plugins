# nudgewhen

Nudges inside Claude Code: take a break, go to bed, and any reminder you set.

- **Break nudges.** The status line counts how long you've been at the keyboard and says `stand up` at twice your limit. Launching an agent after a long sit pops a toast: the agent has this, go walk.
- **Bedtime.** Past your bedtime the status line says it's time to wrap up.
- **Your own nudges.** `/nudge in 20m check the deploy`, or ask Claude: "remind me at 5pm to send the invoice." Due nudges show as a toast, in the status line and as a terminal notification (a desktop banner in terminals that send one).

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
| `/nudge pause` / `pause until 14:30` / `pause tomorrow` | hold until `/nudge resume`, until that time, or until your next wake-up time |
| `/nudge resume` | end a snooze or pause |

Claude gets a `nudge` tool that sets, lists and cancels nudges one at a time, so plain requests work. Cancelling all of them takes your own `/nudge cancel all`. Nudge text is cut to 200 characters with control characters removed, and you can keep up to 100 nudges.

## Settings

Install asks for these; change them later in `/config`.

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
| Status line segments (`status_segments`) | `sit,bed,hosted` | what the status line shows, in order |

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
| `/nudge tone vulgar` | `tone` |

## Tone

The `tone` setting is `plain` (the default, every text as it is) or `vulgar`. Under `vulgar`, each toast and notification says a random line for its kind, drawn from your own lines or, when you have none for it, a short crude starter set. Set it in `/config` or with `/nudge tone plain` or `/nudge tone vulgar`.

Add your own lines with `/nudge line add <kind> <text>`, see them with `/nudge line list [kind]` and remove one with `/nudge line rm <n>` (the number from the full list). You can keep up to 200 lines of up to 200 characters each. A kind with no line of yours uses your `any` lines, then the starters.

| Kind | Used for | Example line |
| --- | --- | --- |
| `break` | the break toast when an agent launches | `{minutes} minutes on your ass. Stand up.` |
| `reminder` | your own `/nudge in`, `at` and `every` reminders | `Remember this, you forgetful bastard: {text}` |
| `ci` | hosted CI nudges | `Pipeline shit the bed: {text}` |
| `review` | hosted review requests and reviews | `Somebody wants your damn opinion: {text}` |
| `landed` | hosted pull request landed nudges | `Merged. Fuck yeah: {text}` |
| `any` | any kind with no line of its own | `Not to be a dick, but: {text}` |

`{minutes}` is how long you have been sitting (in `break` lines) and `{text}` is the nudge's own text. A line with no `{text}` gets the nudge text added after ` - `. Sit, bed and wake lines are not kept: those show only in the status line.

The status entry, `/nudge list` and the setup hints stay plain whatever the tone. Your lines stay on your machine and are never sent to the hosted server.

## Hosted controls

These change what the hosted server sends you. Signed out, each answers with a one-line sign-in hint (`/mcp`).

| Command | Does |
| --- | --- |
| `/nudge prefs` | shows your hosted preferences |
| `/nudge mute owner/repo` | stops nudges from a repository |
| `/nudge unmute owner/repo` | turns them back on |
| `/nudge failures-only on` | CI nudges only for failures (`off` undoes it) |
| `/nudge kinds ci,pr_landed` | which kinds you get: `ci`, `review_requested`, `review_submitted`, `pr_landed` |

`/nudge quiet`, `/nudge pause` and `/nudge resume` also update the server, with your local time zone, when you are signed in. A pause with no end is sent as a far-future time.

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

What a mod cannot read, so only your own `statusLine` command can show it:

- reasoning effort
- fast mode
- the PR badge
- vim mode
- output style

## How it knows you're sitting

On macOS it reads the system idle time (`ioreg`), on Linux `xprintidle` when installed, and otherwise the time since your last prompt. Five minutes with no keyboard or mouse input counts as a break. Nothing leaves your machine except what you set for hosted nudges while connected: quiet hours, a pause time, your time zone and muted repos go to the hosted server. Locally, some data is written down in Claude Code's plugin store: your nudges, the text of nudges that fired in the last ten minutes, and a sitting log (one row per sit and per break, minute resolution, kept 90 days and at most 5000 rows). `/nudge forget` clears the log and the fired-nudge text. A gap with no session open counts as a break, so hours of work with Claude Code closed read as one.

Nudges fire while a Claude Code session is open. One that came due while none was open fires at the next session, marked late.

## License

MIT
