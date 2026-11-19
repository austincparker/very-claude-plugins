#!/usr/bin/env python3
"""Cases for final_check.py. About half exist to prove a rule does NOT fire.

The rules here are house conventions, not grammar universals, so the cheapest
way for this file to go wrong is a rule that fires on prose the author would
genuinely write. Every positive case is paired with the near-miss it must
tolerate.
"""
import os
import pathlib
import subprocess
import sys
import tempfile

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "skills" / "voice" / "scripts" / "final_check.py"

failures = []


def run(text: str, suffix: str = ".md") -> tuple[int, str]:
    with tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False, encoding="utf-8") as f:
        f.write(text)
        path = f.name
    p = subprocess.run([sys.executable, str(SCRIPT), path], capture_output=True, text=True)
    pathlib.Path(path).unlink()
    return p.returncode, p.stdout


def run_paths(paths: list, capture_stderr: bool = False):
    p = subprocess.run([sys.executable, str(SCRIPT), *paths], capture_output=True, text=True)
    if capture_stderr:
        return p.returncode, p.stdout, p.stderr
    return p.returncode, p.stdout


def flags(label: str, text: str, needle: str, suffix: str = ".md") -> None:
    code, out = run(text, suffix)
    if code != 1 or needle not in out:
        failures.append(f"{label}: expected a {needle!r} finding, got rc={code}\n{out}")


def clean(label: str, text: str, suffix: str = ".md") -> None:
    code, out = run(text, suffix)
    if code != 0:
        failures.append(f"{label}: expected clean, got rc={code}\n{out}")


def run_all() -> list:
    failures.clear()
    # --- em dash -----------------------------------------------------------------
    # The rule must fire on a single em dash, not only where both conventions appear.
    # A document written entirely in em dashes is the most likely way to get this
    # wrong, and requiring a mix lets exactly that document pass as clean.
    flags("em dash alone", "Pure em dash prose — nothing else — here.\n", "em dash")
    flags("em dash mixed", "One spaced - hyphen and one — em dash.\n", "em dash")
    clean("spaced hyphen only", "House style - the spaced hyphen - throughout.\n")

    # An em dash inside code or a URL is not prose. Both must be tolerated, because
    # a fenced ASCII diagram uses box-drawing characters freely.
    clean("em dash in a fence", "Text.\n\n```text\n a —▶ b\n```\n\nMore text.\n")
    clean("em dash in inline code", "Run `git log --format=%s — x` and read it.\n")

    # --- doubled words, spelling and arrows --------
    flags("doubled word", "This this is doubled.\n", "doubled")
    clean("legitimate repeat", "The problem she had had was real.\n")
    flags("british spelling", "Pick a nice colour for it.\n", "British")
    clean("american spelling", "Pick a nice color for it.\n")
    flags("mixed arrows", "a -> b and c → d\n", "arrow")
    clean("one arrow style", "a -> b and c -> d\n")

    # --- unreadable input ---------------------------------------------------------
    # A path this script cannot read must fail loud at rc 2, path named on stderr --
    # never a clean report on text it never actually read.
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = pathlib.Path(tmp)

        missing = tmp_path / "missing.md"
        rc, out, err = run_paths([str(missing)], capture_stderr=True)
        if rc != 2:
            failures.append(f"missing path: expected rc 2, got {rc}\n{out}{err}")
        if str(missing) not in err:
            failures.append(f"missing path: expected path in stderr\n{err}")
        if "clean" in out or "clean" in err:
            failures.append(f"missing path: 'clean' must not appear\n{out}{err}")

        a_dir = tmp_path / "a_dir"
        a_dir.mkdir()
        rc, out, err = run_paths([str(a_dir)], capture_stderr=True)
        if rc != 2:
            failures.append(f"directory: expected rc 2, got {rc}\n{out}{err}")
        if str(a_dir) not in err:
            failures.append(f"directory: expected path in stderr\n{err}")

        non_utf8 = tmp_path / "non_utf8.md"
        non_utf8.write_bytes(b"\xff\xfe not valid utf-8\n")
        rc, out, err = run_paths([str(non_utf8)], capture_stderr=True)
        if rc != 2:
            failures.append(f"non-UTF-8 file: expected rc 2, got {rc}\n{out}{err}")
        if str(non_utf8) not in err:
            failures.append(f"non-UTF-8 file: expected path in stderr\n{err}")

        broken_link = tmp_path / "broken_link.md"
        broken_link.symlink_to(tmp_path / "does_not_exist.md")
        rc, out, err = run_paths([str(broken_link)], capture_stderr=True)
        if rc != 2:
            failures.append(f"broken symlink: expected rc 2, got {rc}\n{out}{err}")

        if hasattr(os, "geteuid") and os.geteuid() == 0:
            print("SKIP permission-denied file (running as root)")
        else:
            denied = tmp_path / "denied.md"
            denied.write_text("Hey Sam, the build is up.\n", encoding="utf-8")
            denied.chmod(0o000)
            try:
                rc, out, err = run_paths([str(denied)], capture_stderr=True)
                if rc != 2:
                    failures.append(f"permission-denied file: expected rc 2, got {rc}\n{out}{err}")
                if str(denied) not in err:
                    failures.append(f"permission-denied file: expected path in stderr\n{err}")
            finally:
                denied.chmod(0o644)

        clean_file = tmp_path / "clean.md"
        clean_file.write_text("Hey Sam, the build is up and it looks good.\n", encoding="utf-8")
        rc, out, err = run_paths([str(missing), str(clean_file)], capture_stderr=True)
        if rc != 2:
            failures.append(f"missing + clean file: expected rc 2, got {rc}\n{out}{err}")
        if f"{clean_file} -- clean" not in out:
            failures.append(f"missing + clean file: readable file should still report clean\n{out}")
        if f"{missing} -- clean" in out:
            failures.append(f"missing + clean file: missing path must not get a clean line\n{out}")

        empty_file = tmp_path / "empty.md"
        empty_file.write_text("", encoding="utf-8")
        rc, out, err = run_paths([str(empty_file)], capture_stderr=True)
        if rc != 0 or "clean" not in out:
            failures.append(f"empty file: expected rc 0 and 'clean', got rc={rc}\n{out}{err}")

    # --- code masking: the same spans code_spans.py finds ----------------------
    clean("adjacent same-length code spans", "Use `abc` `xyz` here.\n")
    clean("tilde fence", "Text.\n\n~~~\ncolour colour\n~~~\n\nMore.\n")
    clean("longer fence", "Text.\n\n````\ncolour colour\n````\n\nMore.\n")
    clean("double-backtick span", "Run ``a ` b colour`` now.\n")
    clean("quoted span keeps its own spelling and dashes",
          'He wrote "the colour \u2014 here" and left.\n')
    flags("spelling outside quotes still flagged", 'He wrote "ok" in colour.\n', "British")

    # --- line numbers survive masking ------------------------------------------
    code, out = run("Fine.\n\n```text\na\nb\n```\n\nThe colour is off.\n")
    if "~L8" not in out:
        failures.append(f"line numbers after a fence: expected ~L8\n{out}")
    code, out = run("Stray ` tick here.\nSecond.\nThe colour is off.\n")
    if "~L3" not in out:
        failures.append(f"line numbers after an unpaired backtick: expected ~L3\n{out}")

    # --- space before punctuation, a/an, URLs -----------------------------------
    flags("space before punctuation", "It broke , then it healed.\n", "space before punctuation")
    clean("code then period", "Run `make`.\n")
    flags("a before a vowel", "This is a error.\n", "a/an")
    clean("a before u, eu and one", "A user, a euro and a one-off.\n")
    clean("url is not prose", "See https://example.com/a--b/colour for details.\n")
    clean("a letter is not the article", "Option A is fine and the Q&A answers it.\n")
    flags("a before a vowel after u", "This is a unexpected result.\n", "a/an")
    flags("a capital A opening a line", "A error occurred.\n", "a/an")
    flags("analyse hint", "We analyse it.\n", "'analyse' -> analyze")
    flags("dialogue", "The dialogue box opened.\n", "dialog")

    return list(failures)


def test_final_check():
    assert run_all() == []


if __name__ == "__main__":
    bad = run_all()
    if bad:
        print(f"FAIL ({len(bad)})")
        for f in bad:
            print(" ", f)
        sys.exit(1)
    print("test_final_check: all cases pass")
