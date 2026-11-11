#!/usr/bin/env python3
"""Mechanical grammar and consistency check for outgoing prose.

Three passes cover outgoing prose, and none of them subsumes another:

  voice_gate hook    -> AI tells, against a measured voice profile
  voice cold-reader  -> register, meaning preservation, formality floor
  final_check (this) -> grammar and internal consistency

A clean result from either of the others says nothing about grammar. A doubled
word, or two punctuation conventions used side by side, is this file's to catch
and no other pass claims to look for it.

Reports only. Never edits. Exit 1 when anything is found, so a caller can gate
on it. Exit 2 when an input could not be read at all (missing path, a
directory, undecodable bytes) -- that takes precedence over 1. Readable
files are still checked, and their findings still print.

Usage:  final_check.py FILE [FILE...]
"""
import os
import re
import sys

# Prose only. Code blocks and inline code carry their own conventions, and a
# variable name is not a grammar error. What counts as code is decided by the
# sibling code_spans.py, so both scripts agree on fences and spans.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import code_spans  # noqa: E402

URL = re.compile(r"https?://[^\s\"'<>]+")
# A quoted span is someone else's words and keeps its own punctuation and spelling.
QUOTE = re.compile(r'"[^"\n]{1,200}"')

# Masked text is filled with a character that is neither a word character nor
# whitespace: filler letters made two adjacent same-length spans read as a
# doubled word, and filler spaces read as space-before-punctuation.
FILL = "#"


def _mask(chunk: str) -> str:
    return "".join(c if c in "\r\n" else FILL for c in chunk)


def prose_only(text: str) -> str:
    """Blank out code, URLs and quoted spans, PRESERVING every newline.

    A reported line number that points at the wrong line is worse than none,
    because the reader goes to the line, sees nothing, and stops trusting the
    tool. Fences and inline spans are located by code_spans.py; masking keeps
    the newlines they hold.
    """
    out = []
    for is_fence, chunk in code_spans.split_fences(text):
        if is_fence:
            out.append(_mask(chunk))
            continue
        for is_code, piece in code_spans.split_inline(chunk):
            out.append(_mask(piece) if is_code else piece)
    text = "".join(out)
    text = URL.sub(lambda m: _mask(m.group(0)), text)
    return QUOTE.sub(lambda m: _mask(m.group(0)), text)


# British spellings the house style rejects. Kept short and high-confidence —
# a long list produces false hits on quoted material.
BRITISH = {
    "colour": "color", "colours": "colors", "coloured": "colored",
    "behaviour": "behavior", "behaviours": "behaviors",
    "organise": "organize", "organised": "organized", "organisation": "organization",
    "analyse": "analyse -> analyze", "analysed": "analyzed",
    "licence": "license", "grey": "gray", "cancelled": "canceled",
    "catalogue": "catalog", "dialogue": "dialog (in UI contexts)",
    "defence": "defense", "towards": "toward",
}

# Words that legitimately repeat in English. Without this, every "had had" and
# every table cell boundary reads as a defect.
REPEAT_OK = {"had", "that", "no", "very", "so", "long", "far", "did", "is"}


def check(path: str) -> list[str]:
    body = prose_only(open(path, encoding="utf-8").read())
    out = []

    for m in re.finditer(r"\b(\w+)[ \t]+\1\b", body, re.I):
        if m.group(1).lower() in REPEAT_OK:
            continue
        line = body[: m.start()].count("\n") + 1
        out.append(f"  doubled word ~L{line}: {m.group(0)!r}")

    for wrong, right in BRITISH.items():
        for m in re.finditer(rf"\b{wrong}\b", body, re.I):
            line = body[: m.start()].count("\n") + 1
            out.append(f"  British spelling ~L{line}: {m.group(0)!r} -> {right}")

    # Consistency, not correctness: either convention is fine, mixing them is
    # what reads as unedited.
    ascii_arrow, uni_arrow = body.count("->"), body.count("→")
    if ascii_arrow and uni_arrow:
        out.append(f"  mixed arrows: {ascii_arrow} ascii '->' and {uni_arrow} unicode. Pick one.")

    # ⚠ THE EM DASH FIRES ON ITS OWN, not only against a spaced hyphen.
    # Requiring both meant prose written entirely in em dashes — the most likely
    # way to get this wrong, and the way a machine drafts by default — passed as
    # clean. Measured 2026-09-03: a 70-em-dash page cleared this check and
    # published. House style is the spaced hyphen, so any em dash is the finding.
    em, spaced = body.count("—"), len(re.findall(r"\s-\s", body))
    if em:
        mix = f" alongside {spaced} spaced hyphens" if spaced else ""
        out.append(
            f"  em dash: {em} found{mix}. House style is the spaced hyphen."
        )

    # " ,"  " ." — a reliable sign of a hand edit that moved a word.
    for m in re.finditer(r"\w[ \t]+[,.;:](?=\s|$)", body):
        line = body[: m.start()].count("\n") + 1
        out.append(f"  space before punctuation ~L{line}")

    for m in re.finditer(r"\ba\s+[aeiou]\w+", body, re.I):
        word = m.group(0).split()[-1].lower()
        # Vowel-letter words that take "a": a user, a unique, a one, a euro.
        if word.startswith(("u", "eu", "one")):
            continue
        line = body[: m.start()].count("\n") + 1
        out.append(f"  possible a/an ~L{line}: {m.group(0)!r}")

    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    failed = False
    input_failed = False
    for path in sys.argv[1:]:
        if not os.path.isfile(path):
            reason = "no such file" if not os.path.exists(path) else "not a regular file"
            print(f"final-check: {path}: {reason}", file=sys.stderr)
            input_failed = True
            continue
        try:
            found = check(path)
        except (OSError, UnicodeDecodeError) as exc:
            print(f"final-check: {path}: {exc}", file=sys.stderr)
            input_failed = True
            continue
        if found:
            failed = True
            print(f"final-check: {path}")
            for f in found:
                print(f)
        else:
            print(f"final-check: {path} -- clean")
    if input_failed:
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
