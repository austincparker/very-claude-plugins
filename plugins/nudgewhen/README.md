# nudgewhen

Nudges inside Claude Code: take a break, go to bed, and any reminder you set.

- **Break nudges.** The status line counts how long you've been at the keyboard and says `stand up` at twice your limit. Launching an agent after a long sit pops a toast: the agent has this, go walk.
- **Bedtime.** Past your bedtime the status line says it's time to wrap up.
- **Your own nudges.** `/nudge in 20m check the deploy`, or ask Claude: "remind me at 5pm to send the invoice." Due nudges show as a toast, in the status line and as a terminal notification (a desktop banner in terminals that send one).
- **Idle check.** A session left holding background work can ask itself whether it needs to stay open, and hand off what a script can finish. Off by default.

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
| `/nudge list` | your nudges and how long you've sat |
| `/nudge cancel <id>` / `cancel all` | drop nudges |
| `/nudge report` | breaks and sits, per day |
| `/nudge forget` | clear the sitting log and fired-nudge text |

Claude gets a `nudge` tool that sets, lists and cancels nudges one at a time, so plain requests work. Cancelling all of them takes your own `/nudge cancel all`. Nudge text is cut to 200 characters with control characters removed, and you can keep up to 100 nudges.

## Settings

Install asks for these; change them later in `/config`. **Nudge sessions when idle?** takes effect when the next session starts.

| Setting | Default |
| --- | --- |
| Break nudge after (minutes) | 30 |
| A break is (minutes) with no input | 5 |
| Bedtime nudge | on |
| Bedtime hour | 23 |
| Wake-up hour | 5 |
| Nudge sessions when idle? | off |

## How it knows you're sitting

On macOS it reads the system idle time (`ioreg`), on Linux `xprintidle` when installed, and otherwise the time since your last prompt. Five minutes with no keyboard or mouse input counts as a break. Nothing leaves your machine, but some of it is written down in Claude Code's plugin store: your nudges, the text of nudges that fired in the last ten minutes, and a sitting log (one row per sit and per break, minute resolution, kept 90 days and at most 5000 rows). `/nudge forget` clears the log and the fired-nudge text. A gap with no session open counts as a break, so hours of work with Claude Code closed read as one.

Nudges fire while a Claude Code session is open. One that came due while none was open fires at the next session, marked late.

## Idle check

The `nudgewhen:idle-check` skill asks whether the session truly needs to sit idle. It lists what the session waits on, hands off to a detached script or job whatever needs no judgment, and ends with one line: the session can close, or what still needs it. Run it by hand anytime.

Turn on **Nudge sessions when idle?** and nudgewhen runs it for you. When Claude ends a turn still holding waits and you send no prompt for two minutes, it runs the check. Waits are background shells, agents, workflows, monitors Claude started, and scheduled wake-ups. It runs once per wait: the same waits never trigger it twice, a new one does. A draft in your prompt box holds it off a minute at a time, for up to five minutes. A skill of your own named `idle-check` takes precedence over the plugin's.

It needs plugin hooks turned on, since it reads Claude Code's own end-of-turn report of background work; with hooks off it finds no report and does nothing. The report goes to a private temporary directory made for the session and is deleted when the session ends. With the setting off, the plugin's Stop hook still starts a shell at the end of each turn, and the shell exits at once without writing anything. The check runs a turn, which uses your usage, so the setting is off by default.

## Development

`claude plugin test plugins/nudgewhen` runs the unit tests. It cannot start processes, so run `sh plugins/nudgewhen/tests/stop-hook.sh` as well to check the Stop hook command in `hooks/hooks.json`.

## License

MIT
