# Changelog

## [1.0.1] - 2026-11-13

### Fixed

- A routing prompt denial comes back to Claude as the tool error (`continueOnBlock`), so Claude can run `devibe:voice` and retry once in the same turn. A second denial goes to the user.
- The routing prompt's denial reason is a fixed string that carries no text from the call.

## [1.0.0] - 2026-11-11

### Added

- `asn-lint`: flags backward-looking narration in code, such as comments that explain a deletion instead of just deleting.
- `voice`: a skill and a fresh-context rewrite agent for prose another person will read.
- A stateless voice gate on publishing calls (any GitHub or Gmail MCP server), `Bash`, and the file-writing tools. It denies prose carrying common machine tells and quotes the offending span.
- A routing prompt on GitHub publishing calls that catches prose that never got the voice pass.
- A default profile in `scripts/profiles/default.json`. `VOICE_PROFILE=/path/to/profile.json` points the gate at your own.
