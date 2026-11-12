#!/usr/bin/env python3
"""asn_lint.py — flag Additive Subtractive Nonsense: backward-looking
narration left in a tree, in code and prose alike.

The rule this tool exists to enforce (stated in full in the plugin's
CLAUDE.md / SKILL.md): when something is removed, remove it — don't leave a
comment, a docstring, or a doc claim narrating the fact that it used to be
there. A deletion that ships an explanation of the deletion is not a
deletion, it is a rename: the line count went up and the file now describes
something it no longer contains.

THE CARVE-OUT (the hard part, and the reason this exists as code rather than
a paragraph): a comment that states a forward-looking constraint on code that
still exists is not narration and must not be flagged, even when it is right
next to, or shares vocabulary with, a narration comment that must be. Same
fact, two framings:

    keep:   Must stay above 300ms; Safari drops the event below that.
    keep:   Do not add a retry here -- the gateway retries; this double-fires
            webhooks.
    delete: Removed the 250ms debounce because Safari was dropping events.

The first two constrain code that exists and stop a future mistake. The
third narrates a past one. `classify_narration()` is the line that separates
them -- see the module docstring on that function for the exact rule, and
`test_asn_lint.py` for the confusion matrix and the held-out cases.

Six checks, each its own function below:

    TOMBSTONE_NARRATION          backward-looking comment (see above)
    COMMENTED_OUT_CODE           code-shaped lines kept behind a comment marker
    DOCSTRING_RESTATES_SIGNATURE a docstring that adds nothing past the signature
    RENAMED_SHADOW_FUNCTION      fooNew sitting beside foo
    DEAD_SCAFFOLDING             a definition with no call site anywhere scanned
    DOC_CLAIM_CONTRADICTED       a backticked path/call in a .md that isn't in the tree

This tool only ever reports. It has no `--fix`, no `--apply` -- narration and
scaffolding calls for a judgment a human or the calling agent makes; this
tool's job stops at finding the candidates and being right about the
carve-out.

Usage:
    asn_lint.py PATH [PATH ...]              # files and/or directories
    asn_lint.py PATH --root REPO_ROOT        # resolve doc-claim paths from here
    asn_lint.py PATH --json
    asn_lint.py PATH --only tombstone,dead-scaffolding

Exit 0: no findings. Exit 1: findings reported. Exit 2: usage error.
"""
from __future__ import annotations

import argparse
import builtins
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# ─────────────────────────────────────────────────────────────────────────
# Category names (also the --only slugs)
# ─────────────────────────────────────────────────────────────────────────

TOMBSTONE_NARRATION = "tombstone-narration"
COMMENTED_OUT_CODE = "commented-out-code"
DOCSTRING_RESTATES_SIGNATURE = "docstring-restates-signature"
RENAMED_SHADOW_FUNCTION = "renamed-shadow-function"
DEAD_SCAFFOLDING = "dead-scaffolding"
DOC_CLAIM_CONTRADICTED = "doc-claim-contradicted"

ALL_CATEGORIES = (
    TOMBSTONE_NARRATION,
    COMMENTED_OUT_CODE,
    DOCSTRING_RESTATES_SIGNATURE,
    RENAMED_SHADOW_FUNCTION,
    DEAD_SCAFFOLDING,
    DOC_CLAIM_CONTRADICTED,
)

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".dart_tool", "build",
             ".venv", "venv", ".idea", ".vscode"}

TEXT_EXTS = {
    ".py", ".rb", ".sh", ".fish", ".js", ".jsx", ".ts", ".tsx", ".dart",
    ".swift", ".java", ".kt", ".go", ".c", ".cc", ".cpp", ".h", ".hpp",
    ".rs", ".md", ".markdown", ".yaml", ".yml", ".html", ".htm",
}


@dataclass
class Finding:
    file: str
    line: int
    category: str
    message: str
    snippet: str = ""
    end_line: int = 0

    def render(self) -> str:
        loc = f"{self.file}:{self.line}"
        head = f"{self.category:<28} {loc}"
        if self.snippet:
            return f"{head}\n{' ' * 4}{self.message}\n{' ' * 4}> {self.snippet}"
        return f"{head}\n{' ' * 4}{self.message}"


# ─────────────────────────────────────────────────────────────────────────
# 1. THE CARVE-OUT: backward-narration vs. forward-constraint
# ─────────────────────────────────────────────────────────────────────────

# Backward markers: the comment is describing an edit that already happened
# -- code that used to be here, used to behave differently, or was just
# deleted/replaced/renamed. Presence of any of these is disqualifying
# regardless of what else the comment says, because the backward-looking
# clause is exactly the part that must not ship.
_BACKWARD_PATTERNS = [
    r"\bremoved\b", r"\bdeleted\b", r"\bdropped\b", r"\btook out\b",
    r"\bripped out\b", r"\bgot rid of\b", r"\bpreviously\b", r"\bused to\b",
    r"\boriginally (had|did|was|used|ran)\b",
    r"\bno longer (do|does|need|needs|use|uses|call|calls|run|runs)\b",
    r"\bwe (changed|removed|deleted|replaced)\b",
    r"\breplaced (the|this)\b", r"\bwas replaced\b", r"\breplaces the old\b",
    r"\brenamed from\b", r"\boriginally\b", r"\bthe old \w+\b",
    r"\bold (version|implementation|code|approach)\b",
    r"\bkept (below|here) for reference\b",
    r"\bcommenting this out\b",
    r"\bleft here in case\b", r"\bin case .* comes back\b",
    r"\bformerly\b", r"\bretired\b", r"\bdeprecated\b", r"\brenamed\b",
    r"\bno longer\b", r"\bobsolete\b", r"\bsuperseded\b",
]

# Phrasings that contain a backward word but describe live behavior or bind a
# future edit, so they must not count as narration: a negated or modal clause
# ("must never be deleted"), the passive infinitive "is used to <verb>", and a
# leading participle used as an adjective ("removed items are skipped").
_BACKWARD_VERBS = r"(?:removed|deleted|dropped|renamed|replaced|retired|deprecated)"
_NEUTRAL_PATTERNS = [
    # A modal binds the verb only through a short run of auxiliaries and adverbs
    # ("must never be deleted"); a comma or another clause ends the binding, so
    # "we don't need it anymore, so we removed it" is still narration.
    r"\b(?:must|should|shall|never|cannot|can't|do not|don't|does not|may not|"
    r"will not|won't)(?:\s+(?:never|not|ever|always|be|been|get|gets|ever|silently)){0,3}"
    r"\s+" + _BACKWARD_VERBS + r"\b",
    # Present-tense passive describes live behavior ("pending items are silently dropped").
    r"\b(?:is|are|will be|gets?)\s+(?:\w+ly\s+)?(?:removed|deleted|dropped)\b",
    r"\b(?:is|are|be|being|been|gets?|got)\s+used to\b",
    r"^\s*(?:removed|deleted|dropped)\s+\w+s\s+(?:are|is|will|get|must|can)\b",
    # A backward word used as an adjective after a determiner.
    r"\b(?:the|a|an|any|all|each|every|no|this|that|these|those)\s+"
    r"(?:removed|deleted|dropped|deprecated|retired|renamed|obsolete|superseded)\s+\w+",
]
_NEUTRAL_RE = re.compile("|".join(_NEUTRAL_PATTERNS), re.I)

# Forward markers: the comment is a directive or constraint about code that
# is still here, aimed at someone editing it next. On its own (no backward
# marker present) this is exactly the kind of comment ASN nonsense-hunting
# must leave alone.
_FORWARD_PATTERNS = [
    r"\bmust\b", r"\bdo not\b", r"\bdon't\b", r"\bnever\b", r"\balways\b",
    r"\brequired\b", r"\bneeds? to\b", r"\bkeep (this|it)\b",
]

_BACKWARD_RE = re.compile("|".join(_BACKWARD_PATTERNS), re.I)
_FORWARD_RE = re.compile("|".join(_FORWARD_PATTERNS), re.I)


def classify_narration(text: str) -> str | None:
    """Classify a comment's prose as 'DELETE' (backward-looking narration),
    'KEEP' (forward-looking constraint), or None (neither -- an ordinary
    comment this lint has no opinion about).

    Backward beats forward on purpose: "we removed the retry because it must
    never double-fire" still names a thing that is gone, so the sentence as
    written can't ship. The fix is usually to keep only the forward half --
    this function's job is to say the comment needs a look, not to rewrite
    it.
    """
    if _BACKWARD_RE.search(_NEUTRAL_RE.sub(" ", text)):
        return "DELETE"
    if _FORWARD_RE.search(text):
        return "KEEP"
    return None


# ─────────────────────────────────────────────────────────────────────────
# 2. Comment-block extraction (language-agnostic, line-oriented)
# ─────────────────────────────────────────────────────────────────────────

@dataclass
class CommentBlock:
    start_line: int
    end_line: int
    raw_lines: list = field(default_factory=list)
    stripped_lines: list = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(self.stripped_lines)


_HASH_RE = re.compile(r"^\s*#(?!!)(.*)$")
_SLASH_RE = re.compile(r"^\s*//(.*)$")


def extract_comment_blocks(lines: list[str]) -> list[CommentBlock]:
    """Group consecutive comment lines into blocks. Approximate on purpose --
    this is a lint, not a compiler front end, so it does not track string
    literals containing comment-looking text. Good enough for the six checks
    this module runs, all of which read comment *prose*, not code semantics.
    """
    blocks: list[CommentBlock] = []
    current: CommentBlock | None = None
    in_block_comment = False
    in_html_comment = False

    def close():
        nonlocal current
        if current is not None:
            blocks.append(current)
            current = None

    for i, raw in enumerate(lines, start=1):
        stripped = None
        if in_block_comment:
            m = re.match(r"^(.*?)\*/", raw)
            if m:
                stripped = m.group(1).strip(" *")
                in_block_comment = False
            else:
                stripped = raw.strip(" *")
        elif in_html_comment:
            m = re.match(r"^(.*?)-->", raw)
            if m:
                stripped = m.group(1).strip()
                in_html_comment = False
            else:
                stripped = raw.strip()
        else:
            m = _HASH_RE.match(raw)
            if m:
                stripped = m.group(1).strip()
            else:
                m = _SLASH_RE.match(raw)
                if m:
                    stripped = m.group(1).strip()
                else:
                    m = re.match(r"^\s*/\*(.*)$", raw)
                    if m:
                        rest = m.group(1)
                        m2 = re.match(r"^(.*?)\*/", rest)
                        if m2:
                            stripped = m2.group(1).strip(" *")
                        else:
                            stripped = rest.strip(" *")
                            in_block_comment = True
                    else:
                        m = re.match(r"^\s*<!--(.*)$", raw)
                        if m:
                            rest = m.group(1)
                            m2 = re.match(r"^(.*?)-->", rest)
                            if m2:
                                stripped = m2.group(1).strip()
                            else:
                                stripped = rest.strip()
                                in_html_comment = True

        if stripped is None:
            close()
            continue

        if current is None:
            current = CommentBlock(start_line=i, end_line=i)
        current.end_line = i
        current.raw_lines.append(raw)
        current.stripped_lines.append(stripped)

    close()
    return blocks


# ─────────────────────────────────────────────────────────────────────────
# 3. Commented-out code
# ─────────────────────────────────────────────────────────────────────────

# Each sub-pattern requires code structure (a trailing colon, a paren
# immediately after the keyword, or a name right after def/class), not a bare
# keyword -- "if the timeout fires, retry" must not count just because it
# starts with "if". `raise` / `return` / `assert` / `yield` are the exception:
# no equivalent structural marker exists, so they carry slightly more
# false-positive risk, bounded by the prose guard in is_code_like_line below.
_CODE_START_RE = re.compile(
    r"^(?:"
    r"(?:if|elif|else|for|while|try|except|with)\b.*:$"
    r"|(?:if|for|while)\s*\("
    r"|(?:def|class)\s+\w+"
    r"|(?:raise|return|assert|yield|import|from)\b"
    r")"
)
_CODE_TAIL_RE = re.compile(r"[;{}]\s*$")
_ASSIGN_RE = re.compile(r"^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*\s*=\s*[^=].*[^.]$")
_CALL_RE = re.compile(r"\b[A-Za-z_]\w*\s*\([^()]*\)\s*;?$")


def is_code_like_line(text: str) -> bool:
    t = text.strip()
    if not t or len(t) > 200:
        return False
    has_code_punct = bool(re.search(r"[{}();=]", t))
    if t.endswith((".", "?", "!")) and not has_code_punct:
        return False
    if _CODE_TAIL_RE.search(t):
        return True
    if _CODE_START_RE.match(t):
        return True
    if _ASSIGN_RE.match(t):
        return True
    if _CALL_RE.search(t):
        return True
    return False


def _is_assignment_line(text: str) -> bool:
    return bool(_ASSIGN_RE.match(text.strip()))


def find_commented_out_code(blocks: list[CommentBlock]) -> list[tuple[int, str, int]]:
    """Returns (line, snippet, end line) for comment blocks whose lines are
    predominantly code-shaped rather than prose. Only blocks that
    `classify_narration` did not already claim -- a narration comment that
    happens to mention `foo()` is still narration, not a dead-code stash.
    """
    out = []
    for b in blocks:
        verdict = classify_narration(b.text)
        if verdict == "DELETE":
            continue
        # A block that binds a future edit stays unless its lines are assignments:
        # `# required = True` is disabled code, `# Must stay above 300ms;` is not.
        is_code = _is_assignment_line if verdict == "KEEP" else is_code_like_line
        code_lines = [ln for ln in b.stripped_lines if is_code(ln)]
        if len(b.stripped_lines) >= 2 and len(code_lines) >= 2 and \
                len(code_lines) / len(b.stripped_lines) >= 0.6:
            out.append((b.start_line, b.stripped_lines[0][:80], b.end_line))
        elif len(b.stripped_lines) == 1 and code_lines and verdict is None and \
                _CODE_TAIL_RE.search(code_lines[0]):
            out.append((b.start_line, code_lines[0][:80], b.end_line))
    return out


# ─────────────────────────────────────────────────────────────────────────
# 4. Docstrings that restate the signature
# ─────────────────────────────────────────────────────────────────────────

_PY_DEF_RE = re.compile(
    r"^([ \t]*)def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*[^:]+)?:\s*$"
)
_STOPWORDS = {
    "the", "a", "an", "of", "for", "and", "to", "returns", "return",
    "this", "is", "are", "by", "with", "from", "in", "on", "as", "it",
    "its", "that", "into",
}


def _split_words(name: str) -> set:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name)
    return {w.lower() for w in re.findall(r"[A-Za-z0-9']+", spaced)}


def docstring_restates_signature(name: str, params: list, doc: str) -> bool:
    doc_words = re.findall(r"[A-Za-z0-9']+", doc.lower())
    if not doc_words or len(doc_words) > 10:
        return False
    doc_tokens = {w for w in doc_words if w not in _STOPWORDS}
    if not doc_tokens:
        return False
    sig_tokens = _split_words(name)
    for p in params:
        pname = p.split("=")[0].split(":")[0].strip().lstrip("*")
        if not pname or pname in ("self", "cls"):
            continue
        sig_tokens |= _split_words(pname)
    return doc_tokens.issubset(sig_tokens)


def find_docstring_restatements(lines: list[str]) -> list[tuple[int, str, str]]:
    out = []
    n = len(lines)
    for i, line in enumerate(lines):
        m = _PY_DEF_RE.match(line)
        if not m:
            continue
        indent, name, params_raw = m.group(1), m.group(2), m.group(3)
        params = [p for p in params_raw.split(",") if p.strip()]
        j = i + 1
        while j < n and not lines[j].strip():
            j += 1
        if j >= n:
            continue
        doc_line = lines[j].strip()
        dm = re.match(r'^(?:"""|\'\'\')(.*?)(?:"""|\'\'\')\s*$', doc_line)
        if not dm:
            continue
        doc = dm.group(1).strip()
        if not doc:
            continue
        if docstring_restates_signature(name, params, doc):
            out.append((j + 1, name, doc))
    return out


# ─────────────────────────────────────────────────────────────────────────
# 5. Renamed-shadow functions, and 6. dead scaffolding
# ─────────────────────────────────────────────────────────────────────────

_DEF_RES = [
    re.compile(r"^\s*(?:export\s+)?(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\("),
    re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\("),
    re.compile(
        r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*="
        r"\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[\w<>\[\],. ]+)?\s*=>"
    ),
]

_CAMEL_SUFFIX_RE = re.compile(
    r"^(.+[a-z0-9])(New|Old|V\d+|Copy|Backup|Legacy|Deprecated|Tmp|Alt)$"
)
_SNAKE_SUFFIX_RE = re.compile(
    r"^(.+)_(new|old|v\d+|copy|backup|legacy|deprecated|tmp|alt)$", re.I
)

_ENTRY_POINT_NAMES = {"main", "__init__", "__main__", "setUp", "tearDown"}


def find_func_defs(lines: list[str]) -> list[tuple[int, str]]:
    out = []
    for i, line in enumerate(lines, start=1):
        for rx in _DEF_RES:
            m = rx.match(line)
            if m:
                out.append((i, m.group(1)))
                break
    return out


def base_name_of(name: str):
    m = _CAMEL_SUFFIX_RE.match(name)
    if m:
        return m.group(1).lower()
    m = _SNAKE_SUFFIX_RE.match(name)
    if m:
        return m.group(1).lower()
    return None


def find_shadow_pairs(all_defs: list[tuple[str, int, str]]) -> list[tuple]:
    """all_defs: (file, line, name). Flags (variant_file, variant_line,
    variant_name, base_name) whenever a suffixed name (fooNew, foo_v2, ...)
    coexists with a definition of its unsuffixed base anywhere in the
    scanned set."""
    by_lower = {}
    for _, _, name in all_defs:
        by_lower.setdefault(name.lower(), []).append(name)

    out = []
    for f, ln, name in all_defs:
        base = base_name_of(name)
        if base and base in by_lower and base != name.lower():
            out.append((f, ln, name, base))
    return out


def find_dead_scaffolding(
    all_defs: list[tuple[str, int, str]], corpus: str
) -> list[tuple[str, int, str]]:
    """Flags a definition whose name appears nowhere else in the scanned code
    corpus -- not as a call, a callback, a decorator or an export. Scoped to
    what was scanned: a helper genuinely used only by a file outside the scan
    will false-positive here, which is why the finding is reported as a
    candidate, not applied."""
    defs_per_name: dict[str, int] = {}
    for _, _, name in all_defs:
        defs_per_name[name] = defs_per_name.get(name, 0) + 1
    out = []
    for f, ln, name in all_defs:
        if name in _ENTRY_POINT_NAMES:
            continue
        if re.match(r"^__\w+__$", name):
            continue
        if name.startswith("test_") or name.startswith("_test"):
            continue
        # Every definition of the name accounts for one occurrence.
        occurrences = len(re.findall(r"\b" + re.escape(name) + r"\b", corpus))
        if occurrences <= defs_per_name[name]:
            out.append((f, ln, name))
    return out


# ─────────────────────────────────────────────────────────────────────────
# 7. Doc claims contradicted by the tree
# ─────────────────────────────────────────────────────────────────────────

_BACKTICK_RE = re.compile(r"`([^`\n]+)`")
_PATHLIKE_RE = re.compile(r"[./]")
_FUNCCALL_RE = re.compile(r"^([A-Za-z_]\w*)\(\)$")


# A token carrying any of these is a pattern, a placeholder or an assignment --
# never a claim that a file sits at that path. Testing them for existence is how
# a checker accumulates findings nobody can act on, which is how it stops being run.
_NOT_A_PATH_CLAIM = ("*", "<", ">", "=", "${", "://")

# A version, and an absolute path into the system (not into the repo), are not
# claims about the tree.
_VERSION_RE = re.compile(r"^v?\d+(?:\.\d+)+(?:[-+]\w+)*$")
_SYSTEM_ROOTS = frozenset({
    "usr", "bin", "sbin", "etc", "var", "tmp", "opt", "dev", "proc", "lib",
    "home", "Users", "System", "Library", "Applications", "private", "mnt",
})

# A dotted token with no slash is a file claim only when its suffix is a file
# extension; `example.com`, `process.env` and `np.dot` are not.
_FILE_EXTS = frozenset(TEXT_EXTS | {
    ".json", ".toml", ".cfg", ".ini", ".txt", ".lock", ".css", ".scss", ".svg",
    ".png", ".jpg", ".csv", ".xml", ".sql", ".mjs", ".cjs", ".plist", ".gitignore",
})

# The tree walk does not descend into these, so a claim naming a path inside one
# is checked against the disk directly instead of the walked set.
_MIME_TYPES = frozenset({"application", "text", "image", "audio", "video", "multipart", "font", "message"})

# Calls every language provides; a doc naming one claims nothing about this tree.
_BUILTIN_CALLS = frozenset(dir(builtins)) | frozenset({
    "setTimeout", "setInterval", "clearTimeout", "clearInterval", "parseInt",
    "parseFloat", "require", "fetch", "alert", "isNaN", "eval", "String",
    "Number", "Boolean", "Array", "Object", "Promise", "Symbol", "Date",
})

_TREE_SKIP_DIRS = frozenset({".git", ".claude", "node_modules", "__pycache__", ".venv"})


def find_doc_claim_contradictions(
    md_path: Path, text: str, root: Path, code_corpus: str = "",
    scanned: frozenset[str] = frozenset(),
) -> list[tuple[int, str]]:
    out = []
    for i, line in enumerate(text.splitlines(), start=1):
        for token in _BACKTICK_RE.findall(line):
            tok = token.strip()
            if not tok or " " in tok or tok.startswith("-"):
                continue
            if any(p in tok for p in _NOT_A_PATH_CLAIM):
                continue
            if not tok.strip("/."):          # `/`, `.`, `./` -- a character, not a claim
                continue
            if _VERSION_RE.match(tok):
                continue
            if tok.startswith("/") and tok.split("/")[1] in _SYSTEM_ROOTS:
                continue
            # Home and variable paths name the reader's machine, and `file:12`,
            # `#anchor` and `application/json` are not repo paths.
            if tok.startswith(("~", "$")) or "#" in tok or ":" in tok:
                continue
            if tok.split("/")[0].lower() in _MIME_TYPES and tok.count("/") == 1:
                continue
            suffix = Path(tok).suffix
            # A slashed word with no extension and no trailing slash (`origin/main`,
            # `read/write`, `I/O`) claims a path only when its first segment is a
            # directory of this tree.
            if ("/" in tok and not tok.endswith("/") and not suffix
                    and not tok.startswith(("/", "."))):
                top = tok.split("/")[0] + "/"
                if top not in scanned and not (root / top).is_dir():
                    continue
            if "/" in tok or (suffix and suffix.lower() in _FILE_EXTS):
                def _rel(pth: Path) -> str | None:
                    try:
                        return pth.resolve().relative_to(root.resolve()).as_posix()
                    except ValueError:
                        return None
                # `tree_dirs` stores directories with a trailing slash and `Path`
                # drops it, so try both spellings; the slash form only exists for a
                # directory, and a slashed claim must still name one.
                _slashes = ("/",) if tok.endswith("/") else ("", "/")
                exact = {
                    r + sl
                    for r in (_rel(root / tok), _rel(md_path.parent / tok))
                    if r is not None
                    for sl in _slashes
                }
                # Prose legitimately names a file the reader can already locate --
                # `asn_lint.py`, `profiles/default.json` -- without repeating the
                # directory. For a doc inside a plugin, the nearest ancestor holding
                # `.claude-plugin/` bounds that to its own plugin, so a claim cannot
                # resolve against a same-named file in a different one.
                #
                # A doc at the marketplace root gets no such bound: the root holds a
                # `.claude-plugin/` too, so `subtree` is empty and the whole tree is
                # in scope. That is the right scope for a root-level doc, which may
                # name any file in the repo -- but it is not a per-plugin bound, and
                # a bare basename cited there resolves against whichever plugin has
                # one.
                subtree = ""
                for anc in [md_path.parent, *md_path.parents]:
                    if (anc / ".claude-plugin").is_dir():
                        r = _rel(anc)
                        subtree = "" if r in (None, ".") else r + "/"
                        break
                _tok = tok if tok.endswith("/") else tok + "/"
                suffix_hit = any(
                    s.startswith(subtree)
                    and any(s == t or s.endswith("/" + t) for t in {tok, _tok})
                    for s in scanned
                )
                in_skipped = any(
                    _TREE_SKIP_DIRS.intersection(r.split("/"))
                    and not (root / r.rstrip("/")).is_symlink()
                    and (root / r.rstrip("/")).exists()
                    for r in exact
                )
                if not (exact & scanned) and not suffix_hit and not in_skipped:
                    out.append((i, f"doc references path `{tok}` -- not found "
                                    f"under {root} or {md_path.parent}"))
                continue
            m = _FUNCCALL_RE.match(tok)
            if m:
                name = m.group(1)
                # Only code this run scanned can back a call claim; with no code in
                # the scan (or code in a language it does not parse) there is
                # nothing to contradict it.
                if (len(name) > 2 and name not in _BUILTIN_CALLS and code_corpus
                        and not re.search(r"\b" + re.escape(name) + r"\b", code_corpus)):
                    out.append((i, f"doc references `{tok}` -- no matching "
                                    f"definition found in the scanned code"))
    return out


# ─────────────────────────────────────────────────────────────────────────
# Driver
# ─────────────────────────────────────────────────────────────────────────

def iter_files(paths: list[str]):
    for p in paths:
        path = Path(p)
        if path.is_file():
            yield path
        elif path.is_dir():
            for dirpath, dirnames, filenames in os.walk(path):
                dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS
                                and not d.startswith(".")]
                for fn in filenames:
                    fp = Path(dirpath) / fn
                    # A symlinked file may resolve outside the scanned tree.
                    if fp.suffix in TEXT_EXTS and not fp.is_symlink():
                        yield fp


def lint(paths: list[str], root: str | None = None, only: set | None = None) -> list[Finding]:
    files = list(iter_files(paths))
    only = only or set(ALL_CATEGORIES)
    root_path = Path(root) if root else _infer_root(paths, files)
    # `asn_lint.py one-file.md` infers a root of that file; rglob on a non-directory
    # yields nothing, which reads as "the tree is empty" and fails every claim.
    if not root_path.is_dir():
        root_path = root_path.parent

    per_file_lines: dict[Path, list[str]] = {}
    per_file_text: dict[Path, str] = {}
    all_defs: list[tuple[str, int, str]] = []
    corpus_parts: list[str] = []

    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        per_file_text[f] = text
        lines = text.splitlines()
        per_file_lines[f] = lines
        if f.suffix != ".md":
            corpus_parts.append(text)
            for ln, name in find_func_defs(lines):
                all_defs.append((str(f), ln, name))

    corpus = "\n".join(corpus_parts)
    # Every file under the root, not only the ones this linter parses: a doc
    # legitimately names a .json profile or a .yml workflow, and neither is
    # scanned, so a scanned-only set reports them as absent.
    tree_paths, tree_dirs = set(), set()
    # Only the doc-claim check reads this, and the narration hook runs on every file
    # write with the other checks selected -- walking the tree for those callers
    # bills an rglob per keystroke-sized edit for a set nothing reads.
    for p in (root_path.rglob("*") if DOC_CLAIM_CONTRADICTED in only else ()):
        rel_parts = p.relative_to(root_path).parts
        # Relative, not absolute: a checkout under a directory named `.claude` (the
        # worktree convention here) would otherwise skip its own whole tree and
        # report every backticked path in every doc as missing.
        #
        # rglob does not descend into symlinked directories, so the symlink test is
        # not about loops: a symlinked file resolves a doc claim against a target
        # that may sit outside the tree being linted.
        if _TREE_SKIP_DIRS.intersection(rel_parts) or p.is_symlink():
            continue
        rel = p.relative_to(root_path).as_posix()
        if p.is_file():
            tree_paths.add(rel)
        elif p.is_dir():
            tree_dirs.add(rel + "/")
    scanned_paths = frozenset(tree_paths | tree_dirs)

    findings: list[Finding] = []

    for f, lines in per_file_lines.items():
        rel = str(f)

        if f.suffix != ".md":
            blocks = extract_comment_blocks(lines)

            if TOMBSTONE_NARRATION in only:
                for b in blocks:
                    verdict = classify_narration(b.text)
                    if verdict == "DELETE":
                        findings.append(Finding(
                            rel, b.start_line, TOMBSTONE_NARRATION,
                            "backward-looking narration -- states what used to "
                            "be true rather than a constraint on what is here now",
                            b.text[:100], b.end_line,
                        ))

            if COMMENTED_OUT_CODE in only:
                for ln, snippet, end in find_commented_out_code(blocks):
                    findings.append(Finding(
                        rel, ln, COMMENTED_OUT_CODE,
                        "comment block is code-shaped -- looks like disabled "
                        "code kept behind a comment marker",
                        snippet, end,
                    ))

            if DOCSTRING_RESTATES_SIGNATURE in only:
                for ln, name, doc in find_docstring_restatements(lines):
                    findings.append(Finding(
                        rel, ln, DOCSTRING_RESTATES_SIGNATURE,
                        f"docstring for `{name}` adds nothing past the signature",
                        doc,
                    ))

        if f.suffix == ".md" and DOC_CLAIM_CONTRADICTED in only:
            text = per_file_text[f]
            for ln, msg in find_doc_claim_contradictions(
                    f, text, root_path, corpus, scanned_paths):
                findings.append(Finding(rel, ln, DOC_CLAIM_CONTRADICTED, msg))

    if RENAMED_SHADOW_FUNCTION in only:
        for f, ln, name, base in find_shadow_pairs(all_defs):
            findings.append(Finding(
                f, ln, RENAMED_SHADOW_FUNCTION,
                f"`{name}` sits beside a same-purpose `{base}` -- rename-in-place "
                f"instead of leaving both",
            ))

    if DEAD_SCAFFOLDING in only:
        for f, ln, name in find_dead_scaffolding(all_defs, corpus):
            findings.append(Finding(
                f, ln, DEAD_SCAFFOLDING,
                f"`{name}` has no call site anywhere in the scanned set",
            ))

    findings.sort(key=lambda x: (x.file, x.line, x.category))
    return findings


def _infer_root(paths: list[str], files: list[Path]) -> Path:
    dirs = [Path(p) for p in paths if Path(p).is_dir()]
    if len(dirs) == 1:
        return dirs[0].resolve()
    if files:
        try:
            return Path(os.path.commonpath([str(f.resolve()) for f in files]))
        except ValueError:
            pass
    return Path.cwd()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--root", default=None,
                    help="repo root for resolving doc-referenced paths "
                         "(default: inferred from PATH)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--only", default=None,
                    help="comma-separated category slugs to run, e.g. "
                         f"{TOMBSTONE_NARRATION},{DEAD_SCAFFOLDING}")
    args = ap.parse_args(argv)

    only = set(args.only.split(",")) if args.only else None
    if only:
        bad = only - set(ALL_CATEGORIES)
        if bad:
            print(f"asn-lint: unknown --only categories: {', '.join(sorted(bad))}",
                  file=sys.stderr)
            print(f"valid categories: {', '.join(ALL_CATEGORIES)}", file=sys.stderr)
            return 2

    missing = [p for p in args.paths if not os.path.exists(p)]
    if missing:
        print(f"asn-lint: no such path: {', '.join(missing)}", file=sys.stderr)
        return 2
    if not any(True for _ in iter_files(args.paths)):
        print("asn-lint: no lintable files under the given paths", file=sys.stderr)
        return 2

    findings = lint(args.paths, root=args.root, only=only)

    if args.json:
        print(json.dumps([f.__dict__ for f in findings], indent=2))
    else:
        if not findings:
            print("asn-lint: clean -- no backward-looking narration or scaffolding found")
        else:
            by_cat: dict[str, int] = {}
            for f in findings:
                by_cat[f.category] = by_cat.get(f.category, 0) + 1
                print(f.render())
                print()
            print(f"{len(findings)} finding(s): " +
                  ", ".join(f"{c}={n}" for c, n in sorted(by_cat.items())))
            print("\nReport these -- do not auto-apply. Narration and dead "
                  "scaffolding calls for a human or calling-agent judgment; "
                  "a false positive here (a genuine forward constraint, a "
                  "helper called from outside the scanned set) is cheap to "
                  "dismiss, silently deleting a real constraint is not.")

    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
