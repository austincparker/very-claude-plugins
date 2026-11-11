---
name: asn-lint
posture: labor
color: yellow
allowed-tools: Read, Bash
description: "Use before a diff or a code file goes out the door -- \"check for tombstone comments\", \"lint this for narrated deletions\", \"asn lint\", \"does this comment explain a deletion instead of just deleting\", \"check for dead-code scaffolding\", \"review this PR for backward-looking comments\", \"devibe this file\" (code files and doc-claim checks against the tree, not prose diagnosis -- see `devibe:voice` for \"devibe this prose\"). One lint for backward-looking tombstone narration in code and documentation: tombstone comments and commented-out code in any language, plus four structural checks (docstring restating its signature, renamed-shadow function, uncalled scaffolding, README claim the tree does not back) that currently parse Python, JavaScript and TypeScript only. Wraps scripts/asn_lint.py. Reports only; never edits."
---

# asn-lint

## The invariant

**Read `${CLAUDE_PLUGIN_ROOT}/data/additive-subtractive-nonsense.md` now.** It
holds the rule every devibe surface serves, the reader test that decides a
finding, and the forward-looking exception that keeps a line alive. Report
against it — do not restate it from memory.

**The rule:** when something is removed, remove it. Don't ship a comment, a
docstring, or a doc line that narrates the fact that it used to be there. A
deletion that explains itself is not a deletion -- it's a rename: the line
count went up, and the file now describes something it no longer contains.

This skill wraps `scripts/asn_lint.py`, which runs six checks against one or
more files or directories and reports candidates. It never edits anything.

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/asn_lint.py PATH [PATH ...]
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/asn_lint.py PATH --root REPO_ROOT     # for doc-claim checks
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/asn_lint.py PATH --only tombstone-narration,dead-scaffolding
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/asn_lint.py PATH --json
```

Exit 0: clean. Exit 1: findings reported (report them; do not act on exit
code alone -- see "Report, never apply" below). Exit 2: usage error, e.g. an
unknown `--only` slug.

## The carve-out is the whole point

The hard part of this lint is not finding comments about the past -- it's
telling a narrated deletion apart from a forward-looking constraint that
happens to use similar words. Same underlying fact, two framings:

```
KEEP    Must stay above 300ms; Safari drops the event below that.
KEEP    Do not add a retry here -- the gateway retries; this double-fires webhooks.
DELETE  Removed the 250ms debounce because Safari was dropping events.
```

The first two constrain code that still exists and stop a future mistake.
The third narrates an edit that already happened. `classify_narration()` in
`asn_lint.py` is the function that draws this line: a comment matching a
**backward** marker is `DELETE` regardless of anything else in it; a comment
matching only a **forward** marker (must / never / always / do not /
required / keep this / ...) is `KEEP`. Read `_BACKWARD_PATTERNS` for the
actual list rather than trusting a paraphrase -- several markers are
narrower than their English names suggest (`no longer` fires only before a
verb like *does* or *needs*, and `formerly` is not a marker at all). Backward beats forward when both are present, because the
backward-looking clause is exactly the part that can't ship as written --
the fix is usually to keep only the forward half, not to keep the whole
sentence.

`scripts/test_asn_lint.py` scores 10 DELETE-cases and 10 KEEP-cases through
the real classifier. **It is a regression guard, not evidence the carve-out
generalises** -- each case contains a literal marker from the pattern list,
so the matrix largely restates that list and cannot fail except by deleting
a pattern. An out-of-sample probe of 16 unseen sentences scored 5/16: six
genuinely narrated deletions returned no verdict because they used wording
the patterns do not carry, and two forward-looking constraints were flagged
`DELETE` because a backward marker appeared incidentally ("used to" inside
"used to build the query string").

So: a `DELETE` verdict is a prompt to read the line, never an instruction,
and silence is not a clean bill of health. Widening recall means widening
the patterns, and each widening needs a held-out probe, not another
in-sample case.

## The six checks

| Category slug | What it flags |
|---|---|
| `tombstone-narration` | a comment classified `DELETE` by the carve-out above |
| `commented-out-code` | a comment block whose lines are code-shaped, not prose -- kept "just in case" |
| `docstring-restates-signature` | a one-line Python docstring whose words are a subset of the function name + its parameter names -- adds nothing past the signature |
| `renamed-shadow-function` | `handleClickNew` defined beside a `handleClick` that still exists -- rename in place instead of leaving both |
| `dead-scaffolding` | a definition with zero call sites anywhere in the files handed to the tool |
| `doc-claim-contradicted` | a backticked path or `foo()` call in a `.md` file that doesn't resolve against the tree |

## Known limits -- read these before citing a finding

- **`dead-scaffolding` is scoped to what you pointed it at.** A helper called
  only from a file outside the paths you passed will false-positive. Point
  it at the real usage boundary (a package, not one file) before trusting a
  "nothing calls this" verdict.
- **The narration classifier is keyword-pattern-based, not semantic.** It
  will miss a backward-looking comment phrased with no marker word, and it
  can occasionally flag a forward constraint that happens to use a backward
  word in an unrelated sense. Both directions are cheap to check by reading
  the flagged line -- that's why this tool reports and never applies.
- **`commented-out-code` is heuristic on code shape**, not a real parser for
  any language. It looks for assignment/call/control-flow shapes in comment
  text; a prose comment written in an unusually terse, code-adjacent style
  can trip it.
- **`doc-claim-contradicted` only checks backticked tokens that look like a
  path (contains `/` or a file extension) or a bare `foo()` call.** It does
  not attempt to verify prose claims in general ("supports OAuth", "runs in
  under 100ms") -- that class of doc drift needs a human or a different tool.

## Report, never apply

This is a lint, not a fixer. Findings are candidates for a human or the
calling agent to judge -- a "forward constraint" flagged as narration by
mistake is dismissed by reading one line; a real constraint silently deleted
because a tool auto-applied is not recoverable the same way. Print the
findings; do not edit the target file from this skill.
