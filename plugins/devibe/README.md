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

- PostToolUse on Write, Edit and MultiEdit runs `hooks/asn_lint_hook.py`. It warns rather than denies: the classifier is keyword-based, so a deny would block correct edits. Only findings in lines the edit wrote are reported, and they reach the model as additional context.
- PreToolUse on publishing calls (any GitHub or Gmail MCP server), `Bash`, `Write`, `Edit`, `MultiEdit` and `NotebookEdit` runs `hooks/voice_gate.py`, which denies prose carrying measured tells. Fix the quoted span and send the same call again. A routing prompt on GitHub publishing calls catches prose that never got the voice pass, and hands its reason back to Claude so it can run `devibe:voice` and retry in the same turn.
- `Bash` cannot be matched by what it runs, so every Bash call pays one Python start (about 20 ms). Append `[no-prose]` to a command that carries none. The file tools are judged only for frontmatter types registered with `register_local`; with none registered they pass without a read.
- The matcher is `voice_gate.MCP_GATED` plus the shell and file tools; a test holds the two equal.

## The voice gate

- Stateless: it reads the prose out of the call and denies on measured tells. It holds no marker or TTL, because a permit would authorize a duration, not a document.
- Every rule is data in `scripts/profiles/default.json`; `voice_gate.py` is the mechanism. A rule enters only with zero hits in the author's own writing and material hits in the model's. The profile also lists rules tested and rejected.
- The gate's em dash rule is the pair bracketing an aside, not the character. `final_check.py` (the grammar pass in `devibe:voice`) flags any single em dash.
- `VOICE_PROFILE=/path/to/profile.json` points the gate at another profile. A missing or corrupt profile exits 2 rather than passing prose.
- A wrapper adds local publish paths without forking: `voice_gate.register_local(publish_scripts=[...], prose_frontmatter_types=[...])`, then `voice_gate.main()`.

## Limits

- The gate catches measured tells, not meaning or register; clearing it is not a voice pass.
- `dead-scaffolding` scopes to the paths you give it; point it at a package, not one file. `docstring-restates-signature` is Python only; `doc-claim-contradicted` checks only backticked paths and `foo()` calls.
- `asn-lint` reads whole-line comments only; a trailing comment (`x = 1  # removed the retry`) is not checked.
- The gate reads prose files named on the command line (`--body-file`, `-F`, `--input`, `-d @file`, a `cat` or `echo` piped into `-`) relative to the call's working directory. A file the same command writes, or a stdin source it cannot see, is judged as the command text instead.
- Neither lint auto-fixes.

## Tests

`scripts/test_asn_lint.py`, `test_voice_gate.py`, `test_asn_lint_hook.py`, `test_final_check.py` and `test_voice_code_spans.py` run with `python3 <file>` or `python3 -m pytest <file>`. A new case must fail under the mutation it was written for.

Requires `python3`.
