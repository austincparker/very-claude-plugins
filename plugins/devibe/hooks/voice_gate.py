#!/usr/bin/env python3
"""PreToolUse gate: outward human-facing prose must not read as machine-written.

The gate is stateless. It reads the prose out of the call and denies on measured
tells -- no marker file, no TTL, no subagent, nothing to record and nothing to
expire. Do not give it a permit, a marker or a TTL: any of them authorizes a
*duration* rather than a *document*, so everything sent inside the window rides
through on one pass -- including prose the voice pass never saw, and prose from
another session sharing the file. A detector needs no permit.

WHAT LIVES WHERE
----------------
This file is the mechanism: which calls carry prose, what must never be judged as
prose, and how a finding becomes a denial. Every *rule* is data, in a profile
(`scripts/profiles/default.json`).

The bar a rule must clear to enter a profile is two-sided: it fires ZERO times in
the author's own corpus and materially in the model's. The canonical "AI tells"
mostly fail it -- some are near-zero in both corpora, and several are words the
author uses constantly. A rule that fires on the author's own writing teaches them
to ignore the gate, which costs more than the tell it caught.

The em dash is the instructive case. Authors who use them use them a lot, so the
shipped rule is the PAIR bracketing an aside, not the character. Banning the
character is the version that gets ignored.

MACHINE-LOCAL ADDITIONS
-----------------------
A wrapper adds site-specific surfaces without forking this file:

    import voice_gate
    voice_gate.register_local(
        publish_scripts=[r"\\bmy_publish_script\\.py\\b"],
        prose_frontmatter_types=["email-draft"],
    )
    voice_gate.main()
"""
import json
import os
import re
import shlex
import sys

DEFAULT_PROFILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "scripts", "profiles", "default.json"
)

# ---- what must never be judged as prose ---------------------------------
FENCE = re.compile(r"```.*?```|~~~.*?~~~", re.S)
INLINE_CODE = re.compile(r"`[^`\n]*`")
URL = re.compile(r"https?://\S+")
# Quoted spans are someone else's words. Capped so a whole quoted document
# cannot blank the text and silence every rule.
# Delimiters are the double quote and the backtick only. The ASCII apostrophe is a
# contraction far more often than a quote in this prose, and treating it as a
# delimiter blanks everything between two of them -- "doesn't ... we're" swallows the
# span between, and every rule then reads text that is no longer there. A genuinely
# single-quoted passage loses its exemption; that is rarer than a contraction by a
# wide margin, and the curly apostrophe was never a delimiter here anyway.
QUOTED = re.compile(r"""(["`])(?:(?!\1).){1,200}\1""", re.S)

SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|\n")
# A dash used as punctuation: word, optional space, dash, optional space, word.
# Compound words and numeric ranges do not match.
_NOT_NUMERIC_RANGE = r"(?!\d\s*[—–]\s*\d)"
# Em dash only -- do not widen this to the en dash too. EN_DASH_USE below already
# covers it, and matching both here would double-report the same span under two
# findings.
# The trailing word is a lookahead so `a—b—c` yields two matches, not one.
DASH_USE = re.compile(_NOT_NUMERIC_RANGE + r"\w\s*—\s*(?=\w)")
EN_DASH_USE = re.compile(_NOT_NUMERIC_RANGE + r"\w\s*–\s*\w")


def scrub(text):
    for pat in (FENCE, INLINE_CODE, URL, QUOTED):
        text = pat.sub(" ", text)
    return text


# ---- rules, built from the profile --------------------------------------
def load_profile(path=None):
    with open(path or os.environ.get("VOICE_PROFILE") or DEFAULT_PROFILE) as f:
        return json.load(f)


def build_rules(profile):
    """[(name, fn, guidance)] for the enabled rules in this profile."""
    rules = []
    structural = profile.get("structural", {})

    paired = structural.get("paired_dashes", {})
    if paired.get("enabled"):
        def rule_paired(text):
            return [
                s.strip()[:160]
                for s in SENTENCE_SPLIT.split(text)
                if len(DASH_USE.findall(s)) >= 2
            ]
        rules.append(("paired dashes", rule_paired, paired.get("guidance", "")))

    en = structural.get("en_dash", {})
    if en.get("enabled"):
        def rule_en(text):
            return [m.group(0) for m in EN_DASH_USE.finditer(text)]
        rules.append(("en dash", rule_en, en.get("guidance", "")))

    phrases = [re.compile(p["pattern"], re.I) for p in profile.get("phrases", [])]
    if phrases:
        def rule_phrases(text):
            return [m.group(0) for pat in phrases for m in pat.finditer(text)]
        rules.append((
            "phrase", rule_phrases,
            "a phrase absent from your writing and frequent in the model's. "
            "Say it the way you would say it.",
        ))

    spellings = profile.get("spellings", {})
    pats = spellings.get("patterns", [])
    if pats:
        spell_re = re.compile(r"\b(?:" + "|".join(pats) + r")\w*", re.I)

        def rule_spelling(text):
            return [m.group(0) for m in spell_re.finditer(text)]
        rules.append((
            "spelling", rule_spelling,
            spellings.get("guidance", "") + " Quoted text and symbol names are "
            "exempt and never reach this rule.",
        ))
    return rules


def detect(text, rules):
    text = scrub(text)
    found = []
    for name, fn, guidance in rules:
        hits = fn(text)
        if hits:
            found.append((name, guidance, hits[:3]))
    return found


# ---- which calls carry prose --------------------------------------------
# Anything that puts words in front of another person.
MCP_GATED = re.compile(
    r"^mcp__(?:"
    r"(?:github|claude_ai_GitHub_MCP)__(?:add_issue_comment|issue_write)"
    r"|claude_ai_Gmail__(?:send_message|create_draft|update_draft|reply|forward)"
    r")$"
)

# Substring, not equality. Exact keys miss `commentBody`, and every MCP server
# spells its body parameter slightly differently -- an exact list is always one
# server behind.
PROSE_KEYS = (
    "body", "title", "text", "comment", "summary",
    "description", "commit_message", "message", "notes", "subject", "content",
)
MCP_PROSE_KEYS = PROSE_KEYS
_KEY_ALT = "|".join(PROSE_KEYS)


def mcp_prose(tool_input):
    """Every prose string in an MCP payload, at any depth.

    A ticket or issue payload nests freely -- a field inside `fields`, an ADF
    node inside a list of content blocks -- so the walk must follow dicts and
    lists all the way down rather than stop one level in.
    """
    out = []

    def grab(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if isinstance(v, str) and v.strip() and any(p in k.lower() for p in MCP_PROSE_KEYS):
                    out.append(v)
                elif isinstance(v, (dict, list)):
                    grab(v)
        elif isinstance(node, list):
            for item in node:
                grab(item)

    grab(tool_input)
    return out


# Pull requests are not gated: a PR's title, body, comments and reviews are the
# author writing about their own diff, and a commit message is not a message to
# anyone. What gets gated is prose aimed AT a person: an issue, a release, a gist.
# Global flags may sit between `gh` and the subcommand (`gh -R o/r issue create`).
_GH_GLOBALS = r"(?:(?:-R|--repo)[=\s]+\S+\s+|-\S+\s+)*"
GH_PROSE_SUBCOMMAND = re.compile(
    r"\bgh\s+" + _GH_GLOBALS + r"(?:issue\s+(?:create|comment|edit|close)"
    r"|release\s+(?:create|edit)|gist\s+create)\b"
)
GH_PROSE_FLAG = re.compile(
    r"(?:^|\s)(?:--body(?:-file)?|--title|--notes(?:-file)?|--comment|--desc(?:ription)?"
    r"|-[btnFd])(?:[=\s]|$)"
)
_GH_API = re.compile(r"\bgh\s+api\b")
# The method-override spelling is shared by `gh api` and curl-style writes.
_METHOD_WRITE = r"(?:-X|--request|--method)[=\s]*(?:POST|PUT|PATCH)"
_GH_API_WRITE_VERB = re.compile(
    r"(?:" + _METHOD_WRITE + r"|--field\b|--raw-field\b|\s-[fF](?:\s|\w+=))"
)
_GH_API_PROSE_KEY = re.compile(r"""(?:""" + _KEY_ALT + r""")["']?\s*[=:]""")


# A pull request is named by the endpoint path or by the root fields of a GraphQL
# mutation, never by words inside a payload.
_GH_API_PR_PATH = re.compile(
    r"^/?(?:repos/[^/\s]+/[^/\s]+|repositories/\d+)/pulls(?:/|$)"
)
_GH_PR_ROOT_FIELD = re.compile(r"^(?:\w*PullRequest\w*|(?:un)?resolveReviewThread)$")
_GH_API_ARG_FLAGS = {
    "-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field",
    "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache",
    "-p", "--preview",
}
_GH_QUERY_FIELD = re.compile(r"^(?:-[fF]|--(?:raw-)?field)$")
_GQL_NOISE = re.compile(r'"""[\s\S]*?"""|"(?:[^"\\]|\\.)*"|#[^\n]*')
_GQL_NAME = re.compile(r"[A-Za-z_]\w*")
_SEPARATORS = ";|&\n"
_WINDOW_CAP = 20_000


def _split_commands_sep(cmd):
    """Split on shell separators outside quotes and heredoc bodies, as
    (text, separator) pairs. `&` and `|` inside a redirection (`2>&1`, `>&2`,
    `&>f`, `|&`) are part of it, not separators."""
    spans = {m.start(): m.end() for m in HEREDOC.finditer(cmd)}
    parts, cur, quote, i = [], [], None, 0
    while i < len(cmd):
        if i in spans and quote is None:
            cur.append(cmd[i:spans[i]])
            i = spans[i]
            continue
        c = cmd[i]
        if c == "\\" and quote != "'" and i + 1 < len(cmd):
            cur.append(cmd[i:i + 2])
            i += 2
            continue
        if quote:
            if c == quote:
                quote = None
        elif c in "'\"":
            quote = c
        elif c in _SEPARATORS:
            prev = cmd[i - 1] if i else ""
            nxt = cmd[i + 1] if i + 1 < len(cmd) else ""
            if c in "&|" and (prev in "<>" or (c == "&" and nxt == ">")):
                pass
            else:
                sep = c
                if c == "|" and nxt == "&":
                    sep = "|&"
                parts.append(("".join(cur), sep))
                cur = []
                i += len(sep)
                continue
        cur.append(c)
        i += 1
    parts.append(("".join(cur), ""))
    return parts


def _split_commands(cmd):
    return [t for t, _ in _split_commands_sep(cmd)]


def _gql_root_fields(query):
    """Root field names of every selection set in `query`, or None when it
    holds no mutation. Strings and comments are blanked first."""
    text = _GQL_NOISE.sub(" ", query)
    if not re.search(r"\bmutation\b", text):
        return None
    names, braces, parens, i = [], 0, 0, 0
    while i < len(text):
        c = text[i]
        if c == "{":
            braces += 1
        elif c == "}":
            braces -= 1
        elif c == "(":
            parens += 1
        elif c == ")":
            parens -= 1
        elif braces == 1 and parens == 0:
            m = _GQL_NAME.match(text, i)
            if m and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_")):
                names.append(m.group(0))
                i = m.end()
                continue
        i += 1
    return names


def _targets_pull_request(rest):
    try:
        toks = shlex.split(rest)
    except ValueError:
        toks = rest.split()
    endpoint, i = None, 0
    while i < len(toks):
        t = toks[i]
        if t.startswith("-"):
            if t in _GH_API_ARG_FLAGS:
                i += 1
        else:
            endpoint = t
            break
        i += 1
    if endpoint is None:
        return False
    path = endpoint.split("?", 1)[0]
    if ".." in path or "%" in path:
        return False
    if _GH_API_PR_PATH.match(path):
        return True
    if path.rstrip("/").endswith("graphql"):
        for j, t in enumerate(toks[:-1]):
            if _GH_QUERY_FIELD.match(t) and toks[j + 1].startswith("query="):
                roots = _gql_root_fields(toks[j + 1][len("query="):])
                if roots and all(_GH_PR_ROOT_FIELD.match(n) for n in roots):
                    return True
    return False


def gh_api_write(cmd):
    # Each command, and each `gh api` within it, is judged on its own: a
    # pull-request call must not exempt an issue write chained or nested beside
    # it. A call's window runs to the end of its command, so a nested call cannot
    # hide the outer call's write verb or prose key.
    for part in _split_commands(cmd.replace("\\\n", " ")):
        # Last write verb and prose key in the command, found once: a call is a
        # candidate only when both sit at or after it, and rescanning each
        # window would be quadratic in the number of `gh api` mentions.
        last_verb = max((m.start() for m in _GH_API_WRITE_VERB.finditer(part)), default=-1)
        last_key = max((m.start() for m in _GH_API_PROSE_KEY.finditer(part)), default=-1)
        for m in _GH_API.finditer(part):
            if last_verb < m.end() or last_key < m.end():
                break
            if _targets_pull_request(part[m.end():m.end() + _WINDOW_CAP]):
                continue
            return True
    return False


WRITE_VERB = (
    r"(?:" + _METHOD_WRITE +
    r"|\"(?:POST|PUT|PATCH)\"|'(?:POST|PUT|PATCH)'"
    r"|--data\b|--data-\w+\b|--json\b|\s-d\s)"
)
# Two plain searches ANDed in Python, not one regex with two lookaheads: an
# unanchored `(?=.*A)(?=.*B)` is retried at every start position, and each
# retry re-scans the remainder of the string for A before failing -- quadratic
# on a long command that names neither, such as a large heredoc body.
_OUTWARD_WRITE_DOMAIN = re.compile(r"discord\.com")
_OUTWARD_WRITE_VERB = re.compile(WRITE_VERB, re.S)


def outward_write(cmd):
    return bool(_OUTWARD_WRITE_DOMAIN.search(cmd) and _OUTWARD_WRITE_VERB.search(cmd))


# Per-call escape for a gated surface carrying no prose. Scoped to ONE
# invocation: it is visible in the command a human reviews and expires with it.
# Checked outside quoted spans and heredoc bodies only -- a prose VALUE that
# happens to contain this literal string, wherever the shell lets it sit, must
# not self-exempt the call it is the body of.
NO_PROSE_TOKEN = "[no-prose]"
_SHELL_QUOTED_SPAN = re.compile(
    r"\$'(?:[^'\\]|\\.)*'|'[^']*'|\"(?:[^\"\\]|\\.)*\""
)


def _strip_prose_payloads(cmd):
    """Blank every span the shell lets hold a prose payload: heredoc bodies,
    then quoted flag values. The token must sit outside both to count."""
    text = HEREDOC.sub(lambda m: m.group(0).replace(m.group(2), " " * len(m.group(2)), 1), cmd)
    return _SHELL_QUOTED_SPAN.sub(" ", text)

_LOCAL = {"publish_scripts": [], "prose_frontmatter_types": []}


def register_local(publish_scripts=(), prose_frontmatter_types=()):
    """Add site-specific surfaces. Called by a wrapper before main()."""
    _LOCAL["publish_scripts"].extend(publish_scripts)
    _LOCAL["prose_frontmatter_types"].extend(prose_frontmatter_types)


def _local_publish(cmd):
    return any(re.search(p, cmd) for p in _LOCAL["publish_scripts"])


def gh_prose(cmd):
    return bool(GH_PROSE_FLAG.search(cmd) and GH_PROSE_SUBCOMMAND.search(cmd))


# The prose in a shell command is the VALUE of a prose flag, a heredoc body, or a
# JSON prose field -- not the command line around it. Scanning the whole command
# breaks once quoted spans are exempt: the outer `--body "..."` is itself a quoted
# span, so the exemption swallows exactly the text the rules exist to read.
_VALUE = r"""(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"']\S*))"""
FLAG_VALUE = re.compile(
    r"(?:--body|--title|--notes|--comment|--desc(?:ription)?|-[btnd])[=\s]+" + _VALUE
)
# `gh api -f body="..."` / `--field title=x`: the value follows `key=`.
GH_API_FIELD = re.compile(
    r"(?:-[fF]|--(?:raw-)?field)[=\s]*(?:" + _KEY_ALT + r")=" + _VALUE
)
# The terminator must be a whole line, or a body line that merely starts with
# the delimiter word ends the scanned body early.
HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?\n(.*?)\n\t*\1(?=\n|$)", re.S)
# Each quote style gets its own value alternative so an apostrophe inside a
# double-quoted value (or a double quote inside a single-quoted one) does not end it.
JSON_PROSE_FIELD = re.compile(
    r"""["'](?:""" + _KEY_ALT + r""")["']\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')"""
)


# `--body-file`/`--notes-file`/`-F` name a file whose CONTENTS are the prose. The
# value shapes below cannot see through a path, and the whole-command fallback reads
# the path rather than the prose, so the file is opened here or its prose ships
# unexamined.
# The value stops at shell punctuation, so `--body-file -;` still names stdin.
FLAG_FILE = re.compile(
    r"""(?:--body-file|--notes-file|-F)[=\s]+(?:"([^"]+)"|'([^']+)'|([^\s;|&)<>]+))"""
)

# `-` names stdin, not a path on disk -- opening it as a file always fails. The
# text it carries is whatever an `echo`/`printf` or a `cat <path>` immediately
# before the pipe fed it, and that text IS the prose being published, not a
# quotation inside some other prose, so it is read here rather than left for
# the whole-command fallback (whose quoted-span exemption would blank a
# double-quoted echo, and whose literal command text never contains a cat'd
# file's contents at all). An echo/printf may carry a format argument ahead of
# the value (`printf "%s" "text"`), so the match skips over any prior quoted or
# bare argument to reach the one immediately against the pipe.
# The bare-word alternative cannot start with a quote, so the alternatives are
# disjoint and a long argument list cannot backtrack exponentially.
_ECHO_STDIN_SOURCE = re.compile(
    r"(?:echo|printf)\s+(?:-\S+\s+)*"
    r"(?:(?:\"(?:[^\"\\]|\\.)*\"|'[^']*'|[^\s\"']\S*)\s+)*"
    r"(?:\"((?:[^\"\\]|\\.)*)\"|'([^']*)')\s*\|"
)
_CAT_STDIN_SOURCE = re.compile(r"\bcat\s+(\S+)\s*\|")


def _stdin_source_prose(prefix):
    """The prose fed to a `-` stdin flag by whatever immediately precedes its
    pipe in `prefix`. Several echo/printf/cat pipes can appear earlier in the
    same command, so this takes the one ending closest to the flag, not the
    first one found -- an earlier, unrelated pipe must not stand in for the
    actual payload."""
    candidates = [(m.end(), "echo", m) for m in _ECHO_STDIN_SOURCE.finditer(prefix)]
    candidates += [(m.end(), "cat", m) for m in _CAT_STDIN_SOURCE.finditer(prefix)]
    if not candidates:
        return None
    _, kind, m = max(candidates, key=lambda c: c[0])
    if kind == "echo":
        return m.group(1) if m.group(1) is not None else m.group(2)
    try:
        with open(m.group(1).strip("\"'"), encoding="utf-8", errors="replace") as fh:
            return fh.read(200_000)
    except OSError:
        return None


def _read_prose_file(path):
    path = os.path.expandvars(os.path.expanduser(path))
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read(200_000)


def _flag_file_prose(cmd):
    """(texts, unresolved): the prose in every readable file a flag names, and
    whether any named file could not be opened here."""
    out, unresolved = [], False
    for m in FLAG_FILE.finditer(cmd):
        path = (m.group(1) or m.group(2) or m.group(3)).strip("\"'")
        if path == "-":
            text = _stdin_source_prose(cmd[:m.start()])
            if text and text.strip():
                out.append(text)
            continue
        # `-F key=@file` is a `gh api` field; `-F key=value` carries its value inline.
        field = re.match(r"\w+=(@?)(.*)$", path, re.S)
        if field:
            if not field.group(1):
                continue
            path = field.group(2)
        try:
            text = _read_prose_file(path)
        except OSError:
            unresolved = True
            continue
        if text.strip():
            out.append(text)
    return out, unresolved


def bash_prose(cmd):
    out, unresolved = _flag_file_prose(cmd)
    for rx in (FLAG_VALUE, GH_API_FIELD):
        for m in rx.finditer(cmd):
            v = m.group(1) or m.group(2) or m.group(3) or ""
            if v.strip():
                out.append(v)
    out += [m.group(2) for m in HEREDOC.finditer(cmd) if m.group(2).strip()]
    out += [(m.group(1) or m.group(2)) for m in JSON_PROSE_FIELD.finditer(cmd)
            if (m.group(1) or m.group(2) or "").strip()]
    # Nothing extractable, or a named file this hook cannot open (a relative path
    # after `cd`, a file the same command writes): judge the whole command rather
    # than let prose the shapes above did not anticipate go unexamined.
    if unresolved or not out:
        out.append(cmd)
    return out


def _segment_gated(seg):
    return gh_prose(seg) or gh_api_write(seg)


def _is_pull_request_segment(seg):
    if re.search(r"\bgh\s+pr\b", seg):
        return True
    return any(_targets_pull_request(seg[m.end():]) for m in _GH_API.finditer(seg))


def _gated_text(cmd):
    """`cmd` without the chained commands that only write a pull request, so
    their prose is not judged beside a gated write."""
    segs = _split_commands_sep(cmd.replace("\\\n", " "))
    if len(segs) == 1:
        return cmd
    return "".join(
        t + sep for t, sep in segs
        if _segment_gated(t) or not _is_pull_request_segment(t)
    )


def _is_gated(cmd):
    if _local_publish(cmd) or outward_write(cmd):
        return True
    return any(_segment_gated(t) for t in _split_commands(cmd.replace("\\\n", " ")))


def prose_blobs(tool, tool_input):
    """Every human-facing prose string this call would publish. [] = not gated."""
    if not isinstance(tool_input, dict):
        tool_input = {}

    if MCP_GATED.match(tool):
        return mcp_prose(tool_input)

    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        types = _LOCAL["prose_frontmatter_types"]
        if not types:
            return []
        parts = [
            str(tool_input.get(k, "") or "")
            for k in ("content", "new_string", "new_source")
        ]
        parts += [
            str(e.get("new_string", "") or "")
            for e in tool_input.get("edits") or []
            if isinstance(e, dict)
        ]
        body = "\n".join(parts)
        marker = re.compile(r"^\s*type:\s*(?:" + "|".join(types) + r")\s*$", re.M)
        return [body] if marker.search(body) and body.strip() else []

    if tool == "Bash":
        cmd = tool_input.get("command", "") or ""
        if NO_PROSE_TOKEN in _strip_prose_payloads(cmd):
            return []
        return bash_prose(_gated_text(cmd)) if _is_gated(cmd) else []

    return []


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)
    if not isinstance(payload, dict):
        sys.exit(0)

    # Any failure past this point blocks (exit 2): an uncaught exception exits 1,
    # which does not block, so the call would publish ungated.
    try:
        tool_name = payload.get("tool_name", "") or ""
        blobs = prose_blobs(tool_name, payload.get("tool_input"))
        if not blobs:
            sys.exit(0)
        rules = build_rules(load_profile())
        findings = []
        for blob in blobs:
            findings.extend(detect(blob, rules))
    except Exception as exc:  # noqa: BLE001 - fail closed on any error
        print(f"voice_gate: could not judge this call ({exc.__class__.__name__}: {exc})",
              file=sys.stderr)
        sys.exit(2)
    if not findings:
        sys.exit(0)

    lines = ["voice_gate: this prose carries tells that read as machine-written.", ""]
    for name, guidance, hits in findings:
        lines.append(f"  {name} -- {guidance}")
        for h in hits:
            lines.append(f"      > {h}")
    lines += [
        "",
        "Fix the flagged spans and retry this exact call.",
        "",
        "This gate catches MEASURED TELLS only. Clearing it is not a voice pass.",
        "For human-facing prose run the `devibe:voice` skill, which covers the "
        "lint plus meaning and register.",
        f"If this call carries no prose, append {NO_PROSE_TOKEN} to the command "
        "and retry -- it exempts that one call.",
    ]

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "\n".join(lines),
        }
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
