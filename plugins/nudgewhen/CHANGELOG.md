# Changelog

## [0.4.0]

### Added

- Hosted nudges over the nudgewhen MCP server: CI, review and pull-request-landed nudges, with `/nudge prefs`, `mute`, `unmute`, `failures-only` and `kinds`.
- Bedtime and wake-up as `HH:MM`, plus work hours, work days and quiet hours, each with its own `/nudge` command.
- Status line segments (`status_segments`), tone (`plain` or `vulgar`) with your own lines, and Ghostty tab and window titles.

### Changed

- `bedtime_hour` and `wake_hour` are replaced by `bedtime` and `wake` (`HH:MM`).
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
