#!/usr/bin/env python3
"""pty probe for the nudgewhen status line.

Usage: pty_probe.py route

route: start claude in a pty with ANTHROPIC_API_KEY unset, the plugin loaded and a flag file holding a prior
status line; exit 0 only when the captured screen holds the prior line and the seeded segment.
Exit 1 on any non-usage failure (reason in probe.md), 2 on a missing or bad mode. Never types a prompt.
"""
import fcntl
import glob
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
WORK = os.path.join(ROOT, ".fulcrum", "work", "nudgewhen-statusline")
KEYS = ["nudgewhen@inline", "nudgewhen"]
TRUST = ["Do you trust the files in this folder", "Yes, I trust this folder", "Quick safety check"]
DIALOG = ["Do you want", "Press Enter to continue", "Select login method", "Choose the text style", "Welcome to"]
DROP = ("CLAUDECODE", "CLAUDE_CODE_", "CLAUDE_PID", "CLAUDE_EFFORT", "ANTHROPIC_API_KEY")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]")

state_dir = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "nudgewhen", "status")
children = []


def kill_all(sig):
    for pid in children:
        try:
            os.killpg(pid, sig)
        except OSError:
            pass


def on_signal(signum, _frame):
    kill_all(signal.SIGKILL)
    sys.exit(1)


def squash(s):
    return re.sub(r"\s+", "", s)


def clean_env():
    env = {k: v for k, v in os.environ.items() if not k.startswith(DROP)}
    env["TERM"] = "xterm-256color"
    return env


def run_once(key, sid, marker):
    """Returns (stripped screen, raw screen, argv, notes)."""
    os.makedirs(WORK, exist_ok=True)
    flag = os.path.join(WORK, "flag.json")
    with open(flag, "w") as f:
        json.dump({"statusLine": {"type": "command", "command": "printf prior-ok"},
                   "pluginConfigs": {key: {"options": {"status_line": "wrap"}}}}, f)
    os.makedirs(state_dir, exist_ok=True)
    with open(os.path.join(state_dir, sid + ".txt"), "w") as f:
        f.write("v1 %d\nprobe\nprobe\t%s\n" % (int(time.time() * 1000), marker))
    argv = ["claude", "--model", "sonnet", "--effort", "medium", "--plugin-dir", os.path.join(ROOT, "plugins", "nudgewhen"),
            "--settings", flag, "--debug-file", os.path.join(WORK, "probe-debug.log"), "--session-id", sid,
            "--setting-sources", "project,local"]
    notes = []
    pid, fd = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            os.chdir(ROOT)
            os.execvpe("claude", argv, clean_env())
        except BaseException as e:
            os.write(2, ("exec failed: %r\n" % e).encode())
        finally:
            os._exit(127)
    children.append(pid)
    raw = b""
    trusted_at = None
    start = time.time()
    answered = da = 0
    seen = seen2 = None
    imports = False
    try:
        while True:
            now = time.time()
            if now - start > 45 or (trusted_at is not None and now - trusted_at > 20):
                break
            r, _, _ = select.select([fd], [], [], 0.5)
            if r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                raw += data
            text = ANSI.sub("", raw.decode("utf-8", "replace"))
            if raw.count(b"\x1b[6n") > answered:
                os.write(fd, b"\x1b[1;1R" * (raw.count(b"\x1b[6n") - answered))
                answered = raw.count(b"\x1b[6n")
            if raw.count(b"\x1b[c") > da:  # primary device attributes; input waits on this reply
                os.write(fd, b"\x1b[?62;22c" * (raw.count(b"\x1b[c") - da))
                da = raw.count(b"\x1b[c")
            tail = squash(text[-3000:])  # the TUI moves the cursor instead of printing spaces
            if trusted_at is None and any(squash(t) in tail for t in TRUST):
                seen = seen or time.time()
                if time.time() - seen < 1.5:  # let the menu take input first
                    continue
                if "❯No,exit" in tail:  # the menu opens on "No, exit"; move to "Yes, I trust this folder"
                    os.write(fd, b"\x1b[B")
                    time.sleep(0.3)
                os.write(fd, b"\r")
                notes.append("trust dialog answered: Yes, I trust this folder")
                trusted_at = time.time()
                raw = b""
                answered = da = 0
                continue
            if "AllowexternalCLAUDE.mdfileimports?" in tail and not imports:
                # the operator's global CLAUDE.md imports their own Reserved subjects note; "No" would be saved
                # for this project and stop that note loading in later sessions here
                seen2 = seen2 or time.time()
                if time.time() - seen2 < 1.5:
                    continue
                if "❯No,disableexternalimports" in tail:
                    os.write(fd, b"\x1b[B")
                    time.sleep(0.3)
                os.write(fd, b"\r")
                notes.append("imports dialog answered: Yes, allow external imports")
                imports = True
                trusted_at = time.time()
                raw = b""
                answered = da = 0
                continue
            if trusted_at is None and any(squash(d) in tail for d in DIALOG):
                notes.append("unknown dialog on screen")
                return text, raw.decode("utf-8", "replace"), argv, notes, "unknown dialog"
            if "prior-ok" in text and marker in text:
                break
            if trusted_at is None and "?forshortcuts" in tail:
                trusted_at = time.time()
    finally:
        for _ in range(2):
            try:
                os.write(fd, b"\x03")
            except OSError:
                break
            time.sleep(0.3)
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
            except ChildProcessError:
                break
            try:  # keep draining so a full pty cannot block the child's exit
                if select.select([fd], [], [], 0.2)[0]:
                    os.read(fd, 65536)
            except OSError:
                time.sleep(0.2)
        kill_all(signal.SIGTERM)
        time.sleep(0.5)
        kill_all(signal.SIGKILL)
        os.close(fd)
        for _ in range(50):
            try:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
            except ChildProcessError:
                break
            kill_all(signal.SIGKILL)
            time.sleep(0.1)
        children.remove(pid)
    text = ANSI.sub("", raw.decode("utf-8", "replace"))
    return text, raw.decode("utf-8", "replace"), argv, notes, None


def cleanup(sid):
    for p in glob.glob(os.path.join(state_dir, sid + ".*")):
        os.remove(p)
    for d in (state_dir, os.path.dirname(state_dir)):
        try:
            os.rmdir(d)
        except OSError:
            break


def route():
    sid = str(uuid.uuid4())
    marker = "seg-ok-" + uuid.uuid4().hex[:8]
    others = [p for p in glob.glob(os.path.join(state_dir, "*.prior")) if sid not in p]
    tried, worked, last = [], None, None
    try:
        for key in KEYS:
            tried.append(key)
            text, raw, argv, notes, err = run_once(key, sid, marker)
            prior = os.path.exists(os.path.join(state_dir, sid + ".prior"))
            last = (key, text, raw, argv, notes, err, prior)
            if err is None and "prior-ok" in (text + raw) and marker in (text + raw):
                worked = key
                break
            cleanup(sid)
    finally:
        kill_all(signal.SIGKILL)
        cleanup(sid)
    key, text, raw, argv, notes, err, prior = last
    dbg = ""
    try:
        with open(os.path.join(WORK, "probe-debug.log"), errors="replace") as f:
            dbg = f.read()
    except OSError:
        pass
    lines = [l for l in dbg.splitlines() if re.search(r"settings\.read|overrides installed version|Status line", l)]
    api = [l for l in dbg.splitlines() if "/v1/messages" in l]
    quota = len([l for l in api if "source=quota_check" in l])  # the CLI's own startup quota check, not a prompt
    msgs = len(api) - quota
    with open(os.path.join(WORK, "probe-raw.txt"), "w") as f:
        f.write(raw)
    out = ["# probe route", "argv: " + " ".join(argv), "flag.json: statusLine printf prior-ok, status_line wrap",
           "keys tried: " + ", ".join(tried), "key worked: " + (worked or "none"), "seed: %s.txt %s" % (sid, marker),
           "markers found: prior-ok=%s %s=%s" % ("prior-ok" in text, marker, marker in text),
           ".prior existed: %s" % prior, "other .prior files (not reseeded): %d" % len(others)]
    out += ["note: " + n for n in notes]
    if err:
        out.append("failure: " + err)
    out += ["debug: " + l[:200] for l in lines[:20]]
    out += ["/v1/messages lines other than quota_check: %d (quota_check: %d)" % (msgs, quota), "screen excerpt (raw in probe-raw.txt):"]
    out += ["  " + l for l in text.splitlines() if l.strip()][-15:]
    ok = worked is not None and msgs == 0
    if worked and msgs:
        out.append("failure: /v1/messages seen")
    out.append("route-a: " + ("pass" if ok else "fail"))
    with open(os.path.join(WORK, "probe.md"), "w") as f:
        f.write("\n".join(out) + "\n")
    return 0 if ok else 1


def main():
    if len(sys.argv) != 2 or sys.argv[1] != "route":
        print("usage: pty_probe.py route", file=sys.stderr)
        return 2
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s, on_signal)
    try:
        return route()
    except Exception as e:  # reason goes to probe.md
        os.makedirs(WORK, exist_ok=True)
        with open(os.path.join(WORK, "probe.md"), "w") as f:
            f.write("failure: %r\nroute-a: fail\n" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
