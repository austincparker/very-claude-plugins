# Changelog

## [0.3.0]

### Changed

- Nudge skills are named `<descriptor>-nudge`. The idle check skill is now `nudgewhen:idle-nudge`, and your own override is `idle-nudge`.
- A skill of your own named `idle-check` still runs when there is no `idle-nudge`. The fallback will be removed in 0.4.0; rename it to `idle-nudge`.

### Removed

- **Breaking:** `/nudgewhen:idle-check` is gone, renamed `/nudgewhen:idle-nudge`. Update any script or habit that runs it by name. An `idle-check` skill from another plugin is no longer picked.

## [0.2.0]

### Added

- `nudgewhen:idle-check` skill: lists what an idle session waits on, hands off the mechanical waits to a detached owner, and ends with `Can close` or `Needs me`.
- Setting **Nudge sessions when idle?** (off by default): when a turn ends holding background work or scheduled wake-ups and no prompt follows, run the check once per wait. A draft in the prompt box holds it off.
- A Stop hook that writes the end-of-turn report to a private per-session directory, deleted at session end.
