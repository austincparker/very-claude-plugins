# Changelog

## [0.5.0]

### Added

- A `rules` line kind. Under the vulgar tone, a toast tells you to quit being such a bitch when a settings file gains deny rules, ask rules or `PreToolUse` hooks, or an instruction file (`CLAUDE.md`, `.claude/rules`) gains never-style lines. `/nudge line add rules <text>` sets your own. It shows about one change in three, and not within 12 hours of the last.
- Under the vulgar tone, about one line in four ends in ", you fat lard." (", you fat lard?" for a question).

### Removed

- The idle nudge does not fall back to a skill named `idle-check`; name a personal one `idle-nudge`.

## [0.4.3]

### Changed

- The idle nudge now tells the session that sitting idle is not necessary. The session stays idle only with a valid reason, given in a `Needs me` line.

## [0.4.2]

### Fixed

- Debug log lines, command and tool failure text, and config error text that carry a hosted server reason, a denial or an error message now have control, bidi and zero-width characters replaced with a space and are cut to 200 characters.

## [0.4.1]

### Changed

- The idle nudge's `Needs me` line is written for a reader who knows nothing about the situation: plain words, no unexplained ids, and one short sentence per point after it: what the wait is, what it waits for, why the next step needs judgment, and what happens if the session closes first.

## [0.4.0]

### Added

- Hosted nudges over the nudgewhen MCP server: CI, review and pull-request-landed nudges, with `/nudge prefs`, `mute`, `unmute`, `failures-only` and `kinds`.
- Bedtime and wake-up as `HH:MM`, plus work hours, work days and quiet hours, each with its own `/nudge` command.
- Status line segments (`status_segments`), tone (`plain` or `vulgar`) with your own lines, and Ghostty tab and window titles.

### Changed

- `bedtime_hour` and `wake_hour` are replaced by `bedtime` and `wake` (`HH:MM`). A saved `bedtime_hour` or `wake_hour` still counts as the whole hour while `bedtime` or `wake` is at its default, for this release; set `bedtime` and `wake` in `/config` or with `/nudge bedtime 22:30` and `/nudge wake 06:00`.
- Ghostty titles default to on: a session start now sets the tab and window titles. Set `titles` to `off` to keep your own.
- The plugin now declares the hosted MCP server `https://nudgewhen.dev/mcp`, a third-party service that asks you to sign in. Snooze, pause, resume and quiet hours send their hold, quiet hours and time zone to it once you are signed in; stay signed out and nudgewhen sends it nothing, though Claude Code itself still contacts the server at session start, without credentials, so it can see your IP address and Claude Code's version.
- Local `/nudge` commands wait at most 3 seconds for the hosted server.

### Fixed

- A hosted nudge whose toast was cut short by a restart or session end is shown on the next poll instead of acked unseen.
- `/nudge mute` and `/nudge unmute` keep every muted repo the server holds, however long the list.
- A recurring nudge cut off before its toast shows on the next tick instead of skipping that occurrence.
- `/nudge title set` or `role` after `/nudge title clear` no longer brings the other title back from `NUDGEWHEN_ROLE` or `NUDGEWHEN_SET`.
- Status line files are private to you, and files a dead session left are swept after a day.
- The `idle-check` fallback named in 0.3.0 stays in this release; it is removed in 0.5.0.

## [0.3.0]

### Changed

- Nudge skills are named `<descriptor>-nudge`. The idle check skill is now `nudgewhen:idle-nudge`, and your own override is `idle-nudge`.
- A skill of your own named `idle-check` still runs when you have no `idle-nudge` of your own, ahead of the plugin's `nudgewhen:idle-nudge`. The fallback will be removed in 0.4.0; rename it to `idle-nudge`.
- **Breaking:** Only a skill whose source is `user` counts as your own, where before any non-plugin source did. A project skill that the host lists under another source, an MCP skill or a built-in named `idle-check` or `idle-nudge` is no longer picked, and the plugin's `nudgewhen:idle-nudge` runs instead. To keep an override, put it in a skill of your own named `idle-nudge`.

### Removed

- **Breaking:** `/nudgewhen:idle-check` is gone, renamed `/nudgewhen:idle-nudge`. Update any script, permission rule or habit that runs it by name.

## [0.2.0]

### Added

- `nudgewhen:idle-check` skill: lists what an idle session waits on, hands off the mechanical waits to a detached owner, and ends with `Can close` or `Needs me`.
- Setting **Nudge sessions when idle?** (off by default): when a turn ends holding background work or scheduled wake-ups and no prompt follows, run the check once per wait. A draft in the prompt box holds it off.
- A Stop hook that writes the end-of-turn report to a private per-session directory, deleted at session end.
