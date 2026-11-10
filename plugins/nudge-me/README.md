# nudge-me

Nudges inside Claude Code: take a break, go to bed, and any reminder you set.

- **Break nudges.** The status line counts how long you've been at the keyboard and says `stand up` at twice your limit. Launching an agent after a long sit pops a toast: the agent has this, go walk.
- **Bedtime.** Past your bedtime the status line says it's time to wrap up.
- **Your own nudges.** `/nudge in 20m check the deploy`, or ask Claude: "remind me at 5pm to send the invoice." Due nudges show as a toast, in the status line and as a terminal notification (a desktop banner in terminals that send one).

## Install

```
/plugin install nudge-me --marketplace austincparker/very-claude-plugins
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

Claude gets a `nudge` tool with the same powers, so plain requests work.

## Settings

Install asks for these; change them later in `/config`.

| Setting | Default |
| --- | --- |
| Break nudge after (minutes) | 30 |
| A break is (minutes) with no input | 5 |
| Bedtime nudge | on |
| Bedtime hour | 23 |
| Wake-up hour | 5 |

## How it knows you're sitting

On macOS it reads the system idle time (`ioreg`), on Linux `xprintidle` when installed, and otherwise the time since your last prompt. Five minutes with no keyboard or mouse input counts as a break. Nothing leaves your machine: nudges and the sitting log live in Claude Code's plugin store.

Nudges fire while a Claude Code session is open. One that came due while none was open fires at the next session, marked late.

## License

MIT
