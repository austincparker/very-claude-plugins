#!/usr/bin/env python3
"""Tests for asn_lint.py.

Two parts:

1. THE CARVE-OUT CONFUSION MATRIX -- 20 hand-written one-line comments, 10
   that must be flagged for removal (backward-looking narration) and 10 that
   must survive (forward-looking constraints), run through
   `classify_narration()` and scored. This is the part the task exists to
   prove: that the classifier tells "removed the debounce because Safari was
   dropping events" apart from "must stay above 300ms; Safari drops the
   event below that" on the actual mechanism, not by memorizing the two
   sentences from the spec. Exit non-zero on any misclassification.

2. End-to-end runs of the other five checks against small real files written
   to a temp directory and handed to the actual script (not a mocked
   parser).

Usage: python3 test_asn_lint.py
Exit 0 when every case passes, 1 otherwise.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "asn_lint.py"
_spec = importlib.util.spec_from_file_location("asn_lint", SCRIPT)
mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mod  # dataclass field resolution needs this registered
_spec.loader.exec_module(mod)

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' - ' + detail) if detail else ''}")
        failures.append(name)


# ─────────────────────────────────────────────────────────────────────────
# 1. The carve-out confusion matrix
# ─────────────────────────────────────────────────────────────────────────
print("carve-out: backward narration vs. forward constraint")

# DELETE-cases: backward-looking. Ships an explanation of a past edit.
DELETE_CASES = [
    "Removed the 250ms debounce because Safari was dropping events.",
    "Previously this endpoint returned XML; we switched to JSON in 2024.",
    "This used to call validate() directly but that caused double-"
    "validation, so it's inline now.",
    "We deleted the retry loop here since the caller already retries.",
    "Old implementation kept below for reference:",
    "handleClickNew replaces the old handleClick, which had a stale "
    "closure bug.",
    "No longer used after the migration to the v2 API; left here in case "
    "v1 comes back.",
    "This function was renamed from parse_legacy() when the format changed.",
    "Originally this loop ran twice due to a copy-paste bug, now fixed.",
    "Commenting this out instead of deleting -- might need it again.",
]

# KEEP-cases: forward-looking. A constraint on code that is still here.
KEEP_CASES = [
    "Must stay above 300ms; Safari drops the event below that.",
    "Do not add a retry here -- the gateway retries; this double-fires "
    "webhooks.",
    "Never call this from the main thread; it blocks on disk I/O.",
    "Keep this sorted -- the binary search below assumes ascending order.",
    "Do not remove the null check; the API sends null on rate-limit "
    "responses.",
    "This must run before init_db(), or the migration table won't exist.",
    "Always flush stdout here; the parent process reads this pipe "
    "synchronously.",
    "Required: keep the timeout under 5s or the load balancer kills the "
    "connection.",
    "Don't inline this constant; ops rotates it via config without a "
    "redeploy.",
    "This retry count must stay at 3 -- the vendor API rate-limits after "
    "a 4th attempt within a second.",
]

assert len(DELETE_CASES) >= 8, "need at least 8 delete-cases"
assert len(KEEP_CASES) >= 8, "need at least 8 keep-cases"

# confusion matrix cells: predicted x actual
matrix = {
    ("DELETE", "DELETE"): 0, ("DELETE", "KEEP"): 0, ("DELETE", None): 0,
    ("KEEP", "DELETE"): 0, ("KEEP", "KEEP"): 0, ("KEEP", None): 0,
    (None, "DELETE"): 0, (None, "KEEP"): 0,
}

for text in DELETE_CASES:
    got = mod.classify_narration(text)
    matrix[(got, "DELETE")] = matrix.get((got, "DELETE"), 0) + 1
    check(f"DELETE-case classified DELETE: {text[:52]!r}...", got == "DELETE",
          f"got {got!r}")

for text in KEEP_CASES:
    got = mod.classify_narration(text)
    matrix[(got, "KEEP")] = matrix.get((got, "KEEP"), 0) + 1
    check(f"KEEP-case classified KEEP: {text[:52]!r}...", got == "KEEP",
          f"got {got!r}")

print()
print("  confusion matrix (rows = predicted, cols = actual)")
print(f"  {'':10}{'DELETE':>8}{'KEEP':>8}")
print(f"  {'DELETE':10}{matrix[('DELETE','DELETE')]:>8}{matrix[('DELETE','KEEP')]:>8}")
print(f"  {'KEEP':10}{matrix[('KEEP','DELETE')]:>8}{matrix[('KEEP','KEEP')]:>8}")
print(f"  {'(none)':10}{matrix[(None,'DELETE')]:>8}{matrix[(None,'KEEP')]:>8}")
print()


# ─────────────────────────────────────────────────────────────────────────
# helpers for end-to-end runs
# ─────────────────────────────────────────────────────────────────────────

def run(*args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *[str(a) for a in args]],
        capture_output=True, text=True,
    )


def write(root: Path, rel: str, content: str) -> Path:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return p


# ─────────────────────────────────────────────────────────────────────────
# 2. commented-out code
# ─────────────────────────────────────────────────────────────────────────
print("commented-out code")

with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    write(root, "a.py", '''
def render(items):
    # for item in items:
    #     total = total + item.price
    #     print(total)
    return sum(i.price for i in items)
''')
    r = run(root / "a.py", "--only", mod.COMMENTED_OUT_CODE, "--json")
    check("finds the disabled loop", mod.COMMENTED_OUT_CODE in r.stdout, r.stdout)

with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    write(root, "b.py", '''
def render(items):
    # Sums each item's price. Called once per page render.
    return sum(i.price for i in items)
''')
    r = run(root / "b.py", "--only", mod.COMMENTED_OUT_CODE, "--json")
    check("leaves an ordinary prose comment alone",
          mod.COMMENTED_OUT_CODE not in r.stdout, r.stdout)


# ─────────────────────────────────────────────────────────────────────────
# 3. docstring restates signature
# ─────────────────────────────────────────────────────────────────────────
print("docstring restates signature")

check("flags a pure restatement",
      mod.docstring_restates_signature("get_user_by_id", ["user_id"],
                                        "Get user by id."))
check("leaves a docstring that adds real information alone",
      not mod.docstring_restates_signature(
          "get_user_by_id", ["user_id"],
          "Get user by id, raising UserNotFound if the row is soft-deleted."))

with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    write(root, "c.py", '''
def add(a, b):
    """Add a and b."""
    return a + b
''')
    r = run(root / "c.py", "--only", mod.DOCSTRING_RESTATES_SIGNATURE, "--json")
    check("finds it end-to-end through the file scanner",
          mod.DOCSTRING_RESTATES_SIGNATURE in r.stdout, r.stdout)


# ─────────────────────────────────────────────────────────────────────────
# 4. renamed-shadow function
# ─────────────────────────────────────────────────────────────────────────
print("renamed-shadow function")

with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    write(root, "handlers.js", '''
function handleClick(event) {
  return legacy(event);
}

function handleClickNew(event) {
  return modern(event);
}
''')
    r = run(root / "handlers.js", "--only", mod.RENAMED_SHADOW_FUNCTION, "--json")
    check("flags handleClickNew beside handleClick",
          mod.RENAMED_SHADOW_FUNCTION in r.stdout and "handleClickNew" in r.stdout,
          r.stdout)

with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    write(root, "renew.js", '''
function renewSubscription(id) {
  return charge(id);
}
''')
    r = run(root / "renew.js", "--only", mod.RENAMED_SHADOW_FUNCTION, "--json")
    check("does not treat 'renew' as a suffixed shadow of 'r'",
          mod.RENAMED_SHADOW_FUNCTION not in r.stdout, r.stdout)


# ─────────────────────────────────────────────────────────────────────────
# 5. dead scaffolding
# ─────────────────────────────────────────────────────────────────────────
print("dead scaffolding")

with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    write(root, "d.py", '''
def used_helper(x):
    return x * 2

def unused_helper(x):
    return x * 3

def caller(x):
    return used_helper(x)
''')
    r = run(root / "d.py", "--only", mod.DEAD_SCAFFOLDING, "--json")
    flagged = {f["message"].split("`")[1] for f in json.loads(r.stdout)}
    check("flags the helper nothing calls", "unused_helper" in flagged, r.stdout)
    check("leaves the called helper alone", "used_helper" not in flagged, r.stdout)
    check("also flags caller() itself -- nothing in this file calls it either "
          "(the tool is scoped to what it scanned, per its own doc)",
          "caller" in flagged, r.stdout)


# ─────────────────────────────────────────────────────────────────────────
# 6. doc claim contradicted by the tree
# ─────────────────────────────────────────────────────────────────────────
print("doc claim contradicted by the tree")

with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    write(root, "src/real.py", "def real_thing():\n    return 1\n")
    write(root, "README.md", (
        "See `src/real.py` for the entry point.\n"
        "The old path `src/ghost.py` is no longer part of the build.\n"
    ))
    r = run(root / "README.md", "--root", root, "--only",
            mod.DOC_CLAIM_CONTRADICTED, "--json")
    check("does not flag a path that exists",
          "src/real.py" not in r.stdout.split("src/ghost.py")[0]
          if "src/ghost.py" in r.stdout else "src/real.py" not in r.stdout,
          r.stdout)
    check("flags a path that does not exist",
          "src/ghost.py" in r.stdout, r.stdout)

with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    write(root, "scripts/profiles/default.json", "{}\n")
    write(root, "README.md", (
        "Profiles live in `scripts/profiles` (also `scripts/profiles/`).\n"
        "Nothing is at `scripts/ghostdir`.\n"
    ))
    r = run(root / "README.md", "--root", root, "--only",
            mod.DOC_CLAIM_CONTRADICTED, "--json")
    missing = {f["message"].split("`")[1] for f in json.loads(r.stdout)}
    check("does not flag a directory named without its trailing slash",
          "scripts/profiles" not in missing, r.stdout)
    check("does not flag a directory named with its trailing slash",
          "scripts/profiles/" not in missing, r.stdout)
    check("still flags a missing slash-less path",
          "scripts/ghostdir" in missing, r.stdout)

with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    write(root, ".claude/settings.json", "{}\n")
    write(root, ".claude/skills/demo/SKILL.md", "demo\n")
    write(root, ".git/HEAD", "ref: refs/heads/main\n")
    write(root, "README.md", (
        "Settings live in `.claude/settings.json` under `.claude/`.\n"
        "Skills sit in `.claude/skills/`; history is in `.git` (`.git/`).\n"
        "Nothing is at `.claude/ghost.json`.\n"
    ))
    r = run(root / "README.md", "--root", root, "--only",
            mod.DOC_CLAIM_CONTRADICTED, "--json")
    missing = {f["message"].split("`")[1] for f in json.loads(r.stdout)}
    check("does not flag paths that exist under a walk-skipped directory",
          not missing & {".claude/settings.json", ".claude/", ".claude/skills/",
                         ".git", ".git/"}, r.stdout)
    check("still flags a missing path under a walk-skipped directory",
          ".claude/ghost.json" in missing, r.stdout)


# ─────────────────────────────────────────────────────────────────────────
# 7. exit codes
# ─────────────────────────────────────────────────────────────────────────
print("exit codes")

with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    write(root, "clean.py", '''
def add(a, b):
    return a + b

def main():
    print(add(2, 3))

if __name__ == "__main__":
    main()
''')
    r = run(root / "clean.py")
    check("clean file exits 0", r.returncode == 0, f"rc={r.returncode} {r.stdout}")

with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    write(root, "dirty.py", "# Removed the cache because it went stale.\n"
                            "def add(a, b):\n    return a + b\n")
    r = run(root / "dirty.py")
    check("file with a finding exits 1", r.returncode == 1, f"rc={r.returncode}")

r = run("--only", "not-a-real-category", str(Path(tempfile.gettempdir())))
check("unknown --only category exits 2", r.returncode == 2, f"rc={r.returncode}")


# ─────────────────────────────────────────────────────────────────────────
print()
if failures:
    print(f"{len(failures)} FAILED: {', '.join(failures)}")
    sys.exit(1)
print("all cases passed")
