# devibe

Shapes 1, 6 and 7: skills, hooks and one agent that catch AI narration defects in code and prose.

## Install

```
/plugin install devibe --marketplace austincparker/very-claude-plugins
```

## The invariant

**When you remove something, remove it. Do not add words where the thing used to be.** Both skills read it from `data/additive-subtractive-nonsense.md`, so a finding means the same thing from either.

## Surfaces

- `/devibe:asn-lint`: lints code and markdown for backward-looking comments, commented-out code, dead scaffolding and docstrings that restate their signature. Reports; never edits.
  `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/asn_lint.py <PATH> [--root REPO_ROOT] [--only CATEGORIES] [--json]`
- `/devibe:voice`: rewrites outgoing prose toward a concise, laid-back house voice in a fresh-context agent (`agents/voice.md`) that holds only the draft and its destination. Presents the result; never sends it.

## Hooks

- PostToolUse on Write and Edit runs `hooks/asn_lint_hook.py`. It warns rather than denies: the classifier is keyword-based, so a deny would block correct edits.
- PreToolUse on publishing calls (GitHub, Gmail) and `Bash` runs `hooks/voice_gate.py`, which denies prose carrying measured tells. Fix the quoted span and send the same call again. A routing prompt on non-email publishing calls catches prose that never got the voice pass.
- `Bash` cannot be matched by tool name, so every Bash call pays one Python start (about 20 ms). Append `[no-prose]` to a command that carries none.

## The voice gate

- Stateless: it reads the prose out of the call and denies on measured tells. It holds no marker or TTL, because a permit would authorize a duration, not a document.
- Every rule is data in `scripts/profiles/default.json`; `voice_gate.py` is the mechanism. A rule enters only with zero hits in the author's own writing and material hits in the model's. The profile also lists rules tested and rejected.
- The em dash rule is the pair bracketing an aside, not the character.
- `VOICE_PROFILE=/path/to/profile.json` points the gate at another profile. A missing or corrupt profile exits 2 rather than passing prose.
- A wrapper adds local publish paths without forking: `voice_gate.register_local(publish_scripts=[...], prose_frontmatter_types=[...])`, then `voice_gate.main()`.

## Limits

- The gate catches measured tells, not meaning or register; clearing it is not a voice pass.
- `dead-scaffolding` scopes to the paths you give it; point it at a package, not one file. `docstring-restates-signature` is Python only; `doc-claim-contradicted` checks only backticked paths and `foo()` calls.
- Neither lint auto-fixes.

## Tests

`scripts/test_asn_lint.py`, `test_voice_gate.py`, `test_final_check.py` and `test_voice_code_spans.py` run in `.github/workflows/gates.yml`. A new case must fail under the mutation it was written for.

Requires `python3`.
