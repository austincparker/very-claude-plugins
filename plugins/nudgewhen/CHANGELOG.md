# Changelog

## [0.2.0]

### Added

- `nudgewhen:idle-check` skill: lists what an idle session waits on, hands off the mechanical waits to a detached owner, and ends with `Can close` or `Needs me`.
- Setting **Nudge sessions when idle?** (off by default): when a turn ends holding background work or scheduled wake-ups and no prompt follows, run the check once per wait. A draft in the prompt box holds it off.
- A Stop hook that writes the end-of-turn report to a private per-session directory, deleted at session end.
