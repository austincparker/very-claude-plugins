#!/usr/bin/env python3
"""Mask code spans and fences before a rewrite, restore them byte for byte after.

CommonMark does not decode entities inside code, so a rewriter that
HTML-escapes `&&` or `<key>` inside a code span publishes the escapes as
literal text. Masking swaps every fenced block and inline code span for an
ASCII letters-and-digits placeholder the rewriter has no reason to touch;
restoring puts the originals back and refuses when a placeholder did not
come back exactly once and unaltered.

Usage:
  code_spans.py mask DRAFT [--out PATH] [--spans PATH] [--execute]
  code_spans.py restore REWRITE --spans JSON [--out PATH] [--execute]

Both verbs print one JSON object. Without --execute they check and report
what they would write, and write nothing. Defaults: mask writes
DRAFT.masked.md and DRAFT.spans.json; restore writes REWRITE.restored.md.

Exit codes:
  0  ok
  1  a placeholder check failed (restore; one line names the placeholder)
  2  usage or read error
"""
import argparse
import hashlib
import json
import bisect
import os
import pathlib
import re
import sys

PREFIX = "VOICECODE"
LIST_ITEM = re.compile(r"^ *(?:[-*+]|\d{1,9}[.)])[ \t]")
FENCE_OPEN = re.compile(r"^ *(`{3,}|~{3,})(.*)$")


def fail(code, msg):
    print(msg, file=sys.stderr)
    sys.exit(code)


def read_text(path):
    try:
        return pathlib.Path(path).read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError) as e:
        fail(2, f"cannot read {path}: {e.__class__.__name__}")


def split_fences(text):
    """Yield (is_fence, chunk) pieces that concatenate back to text."""
    lines = re.findall(r"[^\n]*\n|[^\n]+", text)
    pieces, prose, i = [], [], 0
    in_list = False
    while i < len(lines):
        body = lines[i].rstrip("\r\n")
        m = FENCE_OPEN.match(body)
        # A fence indented four or more spaces is indented code, unless it sits
        # inside a list item.
        if m and len(body) - len(body.lstrip(" ")) > 3 and not in_list:
            m = None
        if m and not (m.group(1)[0] == "`" and "`" in m.group(2)):
            ch, n = m.group(1)[0], len(m.group(1))
            j = i + 1
            while j < len(lines):
                c = re.match(r"^ *([`~]+)[ \t]*$", lines[j].rstrip("\r\n"))
                if c and c.group(1)[0] == ch and len(c.group(1)) >= n and set(c.group(1)) == {ch}:
                    break
                j += 1
            end = min(j, len(lines) - 1)
            if prose:
                pieces.append((False, "".join(prose)))
                prose = []
            chunk = "".join(lines[i:end + 1])
            tail = ""
            stripped = chunk.rstrip("\r\n")
            tail = chunk[len(stripped):]
            pieces.append((True, stripped))
            if tail:
                prose.append(tail)
            i = end + 1
        else:
            if LIST_ITEM.match(body):
                in_list = True
            elif body.strip() and not body.startswith(" "):
                in_list = False
            prose.append(lines[i])
            i += 1
    if prose:
        pieces.append((False, "".join(prose)))
    return pieces


def split_inline(text):
    """Split prose into (is_code, chunk) pieces on CommonMark inline code spans."""
    pieces, buf, i, n = [], [], 0, len(text)
    starts = {}
    for m in re.finditer(r"`+", text):
        starts.setdefault(m.end() - m.start(), []).append(m.start())
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n and text[i + 1] in "\\`":
            buf.append(text[i:i + 2])
            i += 2
            continue
        if ch != "`":
            buf.append(ch)
            i += 1
            continue
        j = i
        while j < n and text[j] == "`":
            j += 1
        run = j - i
        close = None
        cands = starts.get(run, [])
        idx = bisect.bisect_left(cands, j)
        if idx < len(cands):
            close = cands[idx] + run
        if close is not None and not re.search(r"\n[ \t]*\r?\n", text[j:close]):
            if buf:
                pieces.append((False, "".join(buf)))
                buf = []
            pieces.append((True, text[i:close]))
            i = close
        else:
            buf.append(text[i:j])
            i = j
    if buf:
        pieces.append((False, "".join(buf)))
    return pieces


def pick_salt(text):
    h = hashlib.sha1(text.encode("utf-8")).hexdigest()
    for width in range(4, len(h) + 1):
        salt = h[:width]
        if PREFIX.lower() + salt not in text.lower():
            return salt
    fail(2, "cannot find a placeholder salt absent from the draft")


def mask(text):
    salt = pick_salt(text)
    spans, out = [], []

    def take(original):
        pid = f"{PREFIX}{salt}N{len(spans) + 1:04d}Z"
        spans.append({"id": pid, "text": original})
        return pid

    for is_fence, chunk in split_fences(text):
        if is_fence:
            out.append(take(chunk))
            continue
        for is_code, piece in split_inline(chunk):
            out.append(take(piece) if is_code else piece)
    return "".join(out), {"version": 1, "salt": salt, "spans": spans}


def restore(text, data):
    spans, salt = data["spans"], data["salt"]
    for s in spans:
        n = text.count(s["id"])
        if n == 0:
            fail(1, f"placeholder missing or altered: {s['id']}")
        if n > 1:
            fail(1, f"placeholder duplicated: {s['id']}")
    known = {s["id"] for s in spans}
    for m in re.finditer(re.escape(PREFIX + salt) + r"N\d{4,}Z", text, re.I):
        if m.group(0) not in known:
            fail(1, f"placeholder unknown or altered: {m.group(0)}")
    by_id = {s["id"]: s["text"] for s in spans}
    return re.sub(re.escape(PREFIX + salt) + r"N\d{4,}Z", lambda m: by_id[m.group(0)], text)


def write(path, content):
    try:
        pathlib.Path(path).write_bytes(content.encode("utf-8"))
    except OSError as e:
        fail(2, f"cannot write {path}: {e.__class__.__name__}")


def distinct(*paths):
    """Refuse a write target that is also an input or another target."""
    real = [os.path.realpath(p) for p in paths]
    if len(set(real)) != len(real):
        fail(2, "input and output paths must all differ")


def load_spans(path):
    """The spans file, validated: a list of {id, text} strings and a salt."""
    try:
        data = json.loads(read_text(path))
        spans, salt = data["spans"], data["salt"]
        ok = isinstance(salt, str) and isinstance(spans, list) and all(
            isinstance(s, dict) and isinstance(s.get("id"), str) and isinstance(s.get("text"), str)
            for s in spans
        )
    except (ValueError, KeyError, TypeError):
        ok = False
    if not ok:
        fail(2, f"cannot parse spans file {path}")
    return data


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="verb", required=True)
    m = sub.add_parser("mask", help="replace code spans and fences with placeholders")
    m.add_argument("draft")
    m.add_argument("--out", help="masked text path (default DRAFT.masked.md)")
    m.add_argument("--spans", help="spans JSON path (default DRAFT.spans.json)")
    m.add_argument("--execute", action="store_true", help="write the files")
    r = sub.add_parser("restore", help="put the original spans back")
    r.add_argument("rewrite")
    r.add_argument("--spans", required=True, help="spans JSON from mask")
    r.add_argument("--out", help="restored text path (default REWRITE.restored.md)")
    r.add_argument("--execute", action="store_true", help="write the file")
    a = ap.parse_args(argv)

    if a.verb == "mask":
        masked, data = mask(read_text(a.draft))
        out = a.out or a.draft + ".masked.md"
        spans = a.spans or a.draft + ".spans.json"
        distinct(a.draft, out, spans)
        if a.execute:
            write(out, masked)
            write(spans, json.dumps(data, ensure_ascii=False, indent=1))
        print(json.dumps({"masked": out, "spans": spans, "count": len(data["spans"]), "executed": a.execute}))
    else:
        data = load_spans(a.spans)
        out = a.out or a.rewrite + ".restored.md"
        distinct(a.rewrite, a.spans, out)
        text = read_text(a.rewrite)
        if a.execute:
            # A failed restore must not leave an earlier run's output behind.
            pathlib.Path(out).unlink(missing_ok=True)
        restored = restore(text, data)
        if a.execute:
            write(out, restored)
        print(json.dumps({"restored": out, "count": len(data["spans"]), "executed": a.execute}))


if __name__ == "__main__":
    main()
