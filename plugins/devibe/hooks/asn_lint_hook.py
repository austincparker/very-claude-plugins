#!/usr/bin/env python3
"""PostToolUse: name candidate tombstones in a file that was just written.

Warns, never denies. `classify_narration()` is a keyword classifier -- an
out-of-sample probe of 16 unseen sentences scored 5/16, missing six real
narrated deletions and flagging two forward-looking constraints that happened
to contain a backward word. A DENY on that would block correct edits, so this
prints what to read and returns control immediately.

Restricted to `tombstone-narration` and `commented-out-code`, the two checks
that work on a single file. `dead-scaffolding` reports "nothing calls this"
from whatever paths it was handed, so on one file it says that about
everything.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LINT = os.path.join(HERE, os.pardir, "scripts", "asn_lint.py")
SKIP_SUFFIXES = (".lock", ".min.js", ".map", ".svg", ".png", ".jpg", ".pdf")
MAX_REPORTED = 5


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0

    path = (event.get("tool_input") or {}).get("file_path")
    if not path or not os.path.isfile(path) or path.endswith(SKIP_SUFFIXES):
        return 0

    try:
        proc = subprocess.run(
            [sys.executable, LINT, path, "--json",
             "--only", "tombstone-narration,commented-out-code"],
            capture_output=True, text=True, timeout=10,
        )
        findings = json.loads(proc.stdout or "[]")
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError, ValueError):
        # A lint that cannot run is not a finding. Stay silent rather than
        # spending the model's attention on this hook's own plumbing.
        return 0

    if not findings:
        return 0

    shown = findings[:MAX_REPORTED]
    lines = [
        f"asn-lint: {len(findings)} candidate(s) in {os.path.basename(path)}. "
        "Read each line before acting -- this classifier is keyword-based and "
        "flags forward-looking constraints too."
    ]
    lines += [f"  L{f['line']} {f['category']}: {f['snippet'][:90]}" for f in shown]
    if len(findings) > len(shown):
        lines.append(f"  ... {len(findings) - len(shown)} more")

    print(json.dumps({"continue": True, "systemMessage": "\n".join(lines)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
