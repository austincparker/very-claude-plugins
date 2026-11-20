# Changelog

## [0.3.0]

### Added

- Hosted nudges over the nudgewhen MCP server: CI, review and pull-request-landed nudges, with `/nudge prefs`, `mute`, `unmute`, `failures-only` and `kinds`.
- Bedtime and wake-up as `HH:MM`, plus work hours, work days and quiet hours, each with its own `/nudge` command.
- Status line segments (`status_segments`), tone (`plain` or `vulgar`) with your own lines, and Ghostty tab and window titles.

### Changed

- `bedtime_hour` and `wake_hour` are replaced by `bedtime` and `wake` (`HH:MM`).

## [0.2.0]

### Added

- `nudgewhen:idle-check` skill: lists what an idle session waits on, hands off the mechanical waits to a detached owner, and ends with `Can close` or `Needs me`.
- Setting **Nudge sessions when idle?** (off by default): when a turn ends holding background work or scheduled wake-ups and no prompt follows, run the check once per wait. A draft in the prompt box holds it off.
- A Stop hook that writes the end-of-turn report to a private per-session directory, deleted at session end.
