# Changelog

## [1.0.0] - 2026-11-11

### Added

- `asn-lint`: flags backward-looking narration in code, such as comments that explain a deletion instead of just deleting.
- `voice`: a skill and a fresh-context rewrite agent for prose another person will read.
- A stateless voice gate on publishing calls (GitHub, Gmail) and `Bash`. It denies prose carrying common machine tells and quotes the offending span.
- A routing prompt on GitHub publishing calls that catches prose that never got the voice pass.
- A default profile in `scripts/profiles/default.json`. `VOICE_PROFILE=/path/to/profile.json` points the gate at your own.
