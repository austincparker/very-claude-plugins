#!/usr/bin/env python3
"""pty probe for the nudgewhen status line.

Usage: pty_probe.py route|smoke

route: start claude in a pty with ANTHROPIC_API_KEY unset, the plugin loaded and a flag file holding a prior
status line; exit 0 only when the captured screen holds the prior line and the seeded segment.
smoke: six real-screen cases (wrap, only, off, scratch repo, no jq, validate) plus a user-settings hash check;
verdicts in smoke.md. Exit 1 on any non-usage failure (reason in probe.md or smoke.md), 2 on a missing or bad
mode. Never types a prompt. Each run writes its files to a new temp directory and prints its path to stderr.
"""
import codecs
import fcntl
import hashlib
import glob
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unicodedata
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
WORK = ""  # main() sets it to a new temp directory
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


class Screen:
    """Small terminal emulator: the rows a person would see after the bytes are drawn."""
    CSI = re.compile(r"[0-?]*[ -/]*[@-~]")
    OSC = re.compile(r"[^\x07\x1b]*(?:\x07|\x1b\\)")

    def __init__(self, rows=40, cols=120):
        self.rows, self.cols = rows, cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.r = self.c = 0
        self.dec = codecs.getincrementaldecoder("utf-8")("replace")
        self.pend = ""

    def lines(self):
        return ["".join(row).rstrip() for row in self.grid]

    def lf(self):
        if self.r == self.rows - 1:
            self.grid.pop(0)
            self.grid.append([" "] * self.cols)
        else:
            self.r += 1

    def put(self, ch):
        if unicodedata.combining(ch):
            return
        w = 2 if unicodedata.east_asian_width(ch) in "WF" else 1
        if self.c + w > self.cols:
            self.c = 0
            self.lf()
        self.grid[self.r][self.c] = ch
        if w == 2:
            self.grid[self.r][self.c + 1] = ""
        self.c += w

    def erase(self, r, a, b):
        for c in range(a, b):
            self.grid[r][c] = " "

    def csi(self, seq):
        final, params = seq[-1], seq[:-1]
        if params[:1] in ("?", ">", "<", "=") or any(ch in " !\"$'" for ch in params):
            return
        try:
            n = [int(x) if x else 0 for x in params.split(";")]
        except ValueError:
            return
        a = n[0] or 1
        if final == "A":
            self.r = max(0, self.r - a)
        elif final == "B":
            self.r = min(self.rows - 1, self.r + a)
        elif final == "C":
            self.c = min(self.cols - 1, self.c + a)
        elif final == "D":
            self.c = max(0, self.c - a)
        elif final in "Hf":
            self.r = min(self.rows - 1, a - 1)
            self.c = min(self.cols - 1, (n[1] if len(n) > 1 and n[1] else 1) - 1)
        elif final == "G":
            self.c = min(self.cols - 1, a - 1)
        elif final == "d":
            self.r = min(self.rows - 1, a - 1)
        elif final == "K":
            m = n[0]
            self.erase(self.r, self.c if m == 0 else 0, self.cols if m in (0, 2) else self.c + 1)
        elif final == "J":
            m = n[0]
            if m == 0:
                self.erase(self.r, self.c, self.cols)
                for r in range(self.r + 1, self.rows):
                    self.erase(r, 0, self.cols)
            elif m == 1:
                self.erase(self.r, 0, self.c + 1)
                for r in range(self.r):
                    self.erase(r, 0, self.cols)
            else:
                for r in range(self.rows):
                    self.erase(r, 0, self.cols)

    def feed(self, data):
        s = self.pend + self.dec.decode(data)
        self.pend = ""
        i, n = 0, len(s)
        while i < n:
            ch = s[i]
            if ch == "\x1b":
                nx = s[i + 1] if i + 1 < n else None
                if nx is None:
                    self.pend = s[i:]
                    break
                if nx in "[]":
                    m = (self.CSI if nx == "[" else self.OSC).match(s, i + 2)
                    if not m:
                        self.pend = s[i:]
                        break
                    if nx == "[":
                        self.csi(m.group())
                    i = m.end()
                elif nx in "()":
                    if i + 2 >= n:
                        self.pend = s[i:]
                        break
                    i += 3
                else:
                    i += 2
                continue
            if ch == "\r":
                self.c = 0
            elif ch == "\n":
                self.lf()
            elif ch == "\b":
                self.c = max(0, self.c - 1)
            elif ch >= " " and ch != "\x7f":
                self.put(ch)
            i += 1


def run_once(key, sid, marker, *, flag=None, flag_path=None, debug=None, cwd=ROOT, env=None, settle=20, poll=None):
    """Returns (stripped screen, raw screen, argv, notes, error). poll(lines, quiet, now) runs each pass; True stops."""
    os.makedirs(WORK, exist_ok=True)
    flag_path = flag_path or os.path.join(WORK, "flag.json")
    debug = debug or os.path.join(WORK, "probe-debug.log")
    if flag is None:
        flag = {"statusLine": {"type": "command", "command": "printf prior-ok"},
                "pluginConfigs": {key: {"options": {"status_line": "wrap"}}}}
    with open(flag_path, "w") as f:
        json.dump(flag, f)
    screen = Screen()
    argv = ["claude", "--model", "sonnet", "--effort", "medium", "--plugin-dir", os.path.join(ROOT, "plugins", "nudgewhen"),
            "--settings", flag_path, "--debug-file", debug, "--session-id", sid,
            "--setting-sources", "project,local"]
    notes = []
    pid, fd = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            os.chdir(cwd)
            os.execvpe("claude", argv, env or clean_env())
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
            if (trusted_at is None and now - start > 45) or (trusted_at is not None and now - trusted_at > settle):
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
                screen.feed(data)
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
                # a global CLAUDE.md may import files outside the project; "No" would be saved for this
                # project and stop those imports in later sessions here
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
            if trusted_at is None and "?forshortcuts" in tail:
                trusted_at = time.time()
            if poll is not None:
                if poll(screen.lines(), not r, time.time()):
                    break
            elif "prior-ok" in text and marker in text:
                break
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
        try:
            os.remove(p)
        except FileNotFoundError:
            pass


def route():
    sids = []
    marker = "seg-ok-" + uuid.uuid4().hex[:8]
    others = [p for p in glob.glob(os.path.join(state_dir, "*.prior")) if not any(s_ in p for s_ in sids)]
    tried, worked, last = [], None, None
    try:
        for key in KEYS:
            tried.append(key)
            sid = str(uuid.uuid4())
            sids.append(sid)
            os.makedirs(state_dir, exist_ok=True)
            with open(os.path.join(state_dir, sid + ".txt"), "w") as f:
                f.write("v1 %d\nprobe\nprobe\t%s\n" % (int(time.time() * 1000), marker))
            text, raw, argv, notes, err = run_once(key, sid, marker)
            prior = os.path.exists(os.path.join(state_dir, sid + ".prior"))
            last = (key, text, raw, argv, notes, err, prior)
            if err is None and "prior-ok" in (text + raw) and marker in (text + raw):
                worked = key
                break
            cleanup(sid)
    finally:
        kill_all(signal.SIGKILL)
        for s_ in sids:
            cleanup(s_)
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


SIDS = []
BUDGET = 480


def sha(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return "absent"


def user_settings():
    return os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "settings.json")


def forget_project(path):
    """Drops the trust and import consent the CLI saved for a scratch directory from the user's .claude.json."""
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    f = os.path.join(cfg, ".claude.json") if cfg else os.path.expanduser("~/.claude.json")
    try:
        with open(f) as fh:
            d = json.load(fh)
        if not isinstance(d.get("projects"), dict) or path not in d["projects"]:
            return
        del d["projects"][path]
        tmp = f + ".nudgewhen-probe.tmp"
        with open(tmp, "w") as fh:
            json.dump(d, fh, indent=2)
        os.replace(tmp, f)
    except (OSError, ValueError):
        pass


def stdin_keys(path):
    try:
        with open(path) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    ks = set()
    for k, v in d.items():
        ks.add(k)
        if isinstance(v, dict):
            ks.update(k + "." + c for c in v)
    has = lambda *names: "yes" if any(n in ks for n in names) else "no"
    cost = "yes" if any(k.startswith("cost.total_lines_") for k in ks) else "no"
    return sorted(ks), {"effort.level": has("effort.level"), "fast_mode": has("fast_mode"), "vim.mode": has("vim.mode"),
                        "pr": has("pr"), "output_style.name": has("output_style.name"),
                        "worktree.name|workspace.git_worktree": has("worktree.name", "workspace.git_worktree"),
                        "workspace.current_dir|cwd": has("workspace.current_dir", "cwd"), "cost.total_lines_*": cost}, \
        os.path.basename((d.get("workspace") or {}).get("current_dir") or d.get("cwd") or "")


def exec_case(name, mode, cwd, D, prior, shows, never, env=None):
    sid = str(uuid.uuid4())
    SIDS.append(sid)
    fl, dbg, rawp = [os.path.join(WORK, "smoke-%s-%s" % (name, x)) for x in ("flag.json", "debug.log", "raw.txt")]
    if os.path.exists(dbg):
        os.remove(dbg)
    seg, prf = os.path.join(state_dir, sid + ".txt"), os.path.join(state_dir, sid + ".prior")
    flag = {"pluginConfigs": {"nudgewhen@inline": {"options": {"status_line": mode, "status_segments": "breaks,dir"}}}}
    if prior:
        flag["statusLine"] = {"type": "command", "command": prior, "refreshInterval": 2}
    c = dict(name=name, sid=sid, seen=None, content=None, prior_seen=None, shown=None, viol=[], dup=False, frame=[], t0=None,
             checks=[], mode=mode, cwd=cwd, flag=flag, D=D, seg=seg)
    row_re = re.compile(r"breaks\d+·" + re.escape(D))
    c["row"] = lambda r: bool(row_re.search(r))
    c["dup_row"] = lambda r: bool(re.search(r"breaks\d+", r)) and not row_re.search(r)

    def poll(lines, quiet, now):
        if c["t0"] is None:
            c["t0"] = now
        try:
            if os.path.exists(seg):
                if c["seen"] is None:
                    c["seen"] = now - c["t0"]
                with open(seg) as f:
                    c["content"] = f.read()
            if os.path.exists(prf):
                with open(prf) as f:
                    c["prior_seen"] = f.read()
        except OSError:
            pass
        if not quiet:
            return False
        c["frame"] = lines
        rows = [squash(l) for l in lines]
        if any(c["dup_row"](r) for r in rows):
            c["dup"] = True
        if c["shown"] is None and shows(lines, rows, c):
            c["shown"] = now
        if c["shown"] is not None:
            c["viol"] += [v for v in never(lines, rows, c) if v not in c["viol"]]
            return now - c["shown"] >= 5
        return False

    text, raw, argv, notes, err = run_once("nudgewhen@inline", sid, "", flag=flag, flag_path=fl, debug=dbg, cwd=cwd, env=env,
                                           settle=40, poll=poll)
    with open(rawp, "w") as f:
        f.write(raw)
    if not c["frame"]:
        c["frame"] = Screen_last(raw)
    c.update(argv=argv, notes=notes)
    try:
        with open(dbg, errors="replace") as f:
            dl = f.read().splitlines()
    except OSError:
        dl = []
    c["dl"] = dl
    c["sl"] = [l.split("StatusLine [", 1)[1] for l in dl if "StatusLine [" in l]
    sel = [l for l in dl if "StatusLine [" in l or "settings.read" in l or "nudgewhen" in l]
    c["dbg"] = [l[:200] for l in sel if "Broken symlink" not in l][:25]

    def chk(label, ok, detail=""):
        c["checks"].append((label, bool(ok), detail))

    c["chk"] = chk
    chk("ready, no dialog error", err is None, err or "")
    chk("shows", c["shown"] is not None)
    chk("never shows %s" % ",".join(c["viol"]) if c["viol"] else "never shows forbidden rows", not c["viol"])
    return c


def Screen_last(raw):
    sc = Screen()
    sc.feed(raw.encode("utf-8", "replace"))
    return sc.lines()


def render(c, extra=()):
    ok = all(x[1] for x in c["checks"])
    o = ["## case " + c["name"], "argv: " + " ".join(c["argv"]), "cwd: " + c["cwd"], "flag: " + json.dumps(c["flag"]),
         "segment file: " + ("seen after %.1fs; %r" % (c["seen"], (c["content"] or "")[:200]) if c["seen"] is not None else "never appeared")]
    o += ["note: " + n for n in c["notes"]] + list(extra) + ["debug: " + l for l in c["dbg"]]
    o.append("screen (quiet frame at verdict):")
    o += ["  " + l for l in c["frame"] if l.strip()][-12:]
    o += ["[%s] %s %s" % ("pass" if k else "fail", n, d) for n, k, d in c["checks"]]
    o.append("verdict: " + ("pass" if ok else "fail"))
    return o, ok


def smoke():
    T0 = time.time()
    M = uuid.uuid4().hex[:8]
    RUN = os.path.join(WORK, "smoke-run-" + M)
    os.makedirs(RUN)
    D0 = os.path.basename(ROOT)
    st = user_settings()
    h0 = sha(st)
    head = ["# probe smoke", "argv: claude --model sonnet --effort medium --plugin-dir ... --setting-sources project,local (per case)",
            "settings file: " + st, "sha256 before: " + h0]
    body, keys, results, carried, SCR = [], [], [], [], None
    ROW = lambda c: (lambda r: c["row"](r))
    nextrow = lambda lines, rows, i: rows[i + 1] if i + 1 < len(rows) else ""

    def run_case(name, fn):
        if time.time() - T0 > BUDGET:
            body.extend(["## case " + name, "not run: budget", "verdict: fail not run: budget"])
            results.append(False)
            return
        try:
            c = fn()
            lines, ok = render(c, c.pop("extra", []))
        except Exception as e:
            lines, ok = ["## case " + name, "failure: %r" % e, "verdict: fail exception"], False
            c = None
        body.extend(lines)
        results.append(ok)
        return c

    def tail(c, label, cond, detail=""):
        c["chk"](label, cond, detail)

    def launcher(c):
        return any("/bin/statusline " + c["mode"] in l for l in c["sl"])

    def direct(c, prior):
        return any(l.startswith(prior) for l in c["sl"])

    def note_carried(c):
        """Records whether the launcher drew the mod's segment row for case `c`."""
        content = (c["content"] or "").splitlines()
        if c["seen"] is not None and c["shown"] is not None:
            r = "yes"
        elif c["seen"] is None and c["dup"]:
            r = "no - mod drew ui.status and wrote no segment file; " + " | ".join(l[:160] for l in c["dl"] if "settings.read" in l)[:600]
        elif c["seen"] is not None:
            r = "launcher row missing despite segment file"
        else:
            r = "no segment file and no row"
        if content[1:2] and content[1] != "breaks,dir":
            r += "; status_segments did not reach options"
        carried.append((c["name"], r))

    try:
        # validate
        try:
            pr = subprocess.run(["claude", "plugin", "validate", "plugins/nudgewhen"], cwd=ROOT, env=clean_env(), timeout=120,
                                capture_output=True, text=True)
            vt = (pr.stdout + pr.stderr).splitlines()[-15:]
            vok = pr.returncode == 0
            val = ["## validate", "exit: %d" % pr.returncode] + ["  " + l for l in vt]
        except Exception as e:
            vok, val = False, ["## validate", "failure: %r" % e]
        val.append("verdict: " + ("pass" if vok else "fail"))

        def prior_file(n, text):
            path = os.path.join(RUN, n)
            with open(path, "w") as f:
                f.write(text)
            return "sh '%s'" % path

        def wrap_slow():
            prior = prior_file("prior-slow.sh", "cat > '%s/stdin-wrap.json'\nn=$(cat '%s/slow.count' 2>/dev/null || echo 0)\nn=$((n+1))\n"
                               "echo $n > '%s/slow.count'\nif [ $n -le 3 ]; then echo first-%s; else sleep 3; echo late-%s; fi\n" % (RUN, RUN, RUN, M, M))

            def count():
                try:
                    return int(open(os.path.join(RUN, "slow.count")).read())
                except (OSError, ValueError):
                    return 0

            def shows(lines, rows, c):
                return count() >= 5 and any("first-" + M in r and ROW(c)(nextrow(lines, rows, i)) for i, r in enumerate(rows))

            never = lambda lines, rows, c: [v for v, f in (("late-" + M, lambda r: "late-" + M in r), ("DUP", c["dup_row"])) if any(f(r) for r in rows)]
            c = exec_case("wrap-slow", "wrap", ROOT, D0, prior, shows, never)
            c["chk"]("launcher ran", launcher(c))
            first = next((i for i, l in enumerate(c["sl"]) if "/bin/statusline" in l), None)
            c["chk"]("prior never ran directly after the launcher took over",
                     first is not None and not direct(dict(c, sl=c["sl"][first + 1:]), prior))
            c["chk"](".prior holds first-" + M, c["prior_seen"] is not None and "first-" + M in c["prior_seen"], repr(c["prior_seen"]))
            c["chk"]("stdin captured", os.path.exists(os.path.join(RUN, "stdin-wrap.json")))
            c["extra"] = ["slow.count: %d" % count()]
            note_carried(c)
            return c

        def only():
            never = lambda lines, rows, c: [v for v, f in (("only-" + M, lambda r: "only-" + M in r), ("DUP", c["dup_row"])) if any(f(r) for r in rows)]
            c = exec_case("only", "only", ROOT, D0, "printf 'only-%s\\n'" % M, lambda l, rows, c: any(c["row"](r) for r in rows), never)
            # The engine logs a status line run only when it printed, and the launcher's first run under only
            # prints nothing, so the segment file and the never-shows check on only-M judge it, not the debug log.
            c["chk"]("segment file seen", c["seen"] is not None)
            c["chk"]("no .prior file", c["prior_seen"] is None)
            note_carried(c)
            return c

        def off():
            shows = lambda l, rows, c: any("off-" + M in r for r in rows) and any(re.search(r"breaks\d+", r) for r in rows)
            never = lambda l, rows, c: ["ROW"] if any(c["row"](r) for r in rows) else []
            c = exec_case("off", "off", ROOT, D0, "printf 'off-%s\\n'" % M, shows, never)
            c["chk"]("prior ran directly, no launcher", direct(c, "printf 'off-") and not any("/bin/statusline" in l for l in c["sl"]))
            c["chk"]("segment file never appeared", c["seen"] is None)
            c["chk"]("no .prior file", c["prior_seen"] is None)
            return c

        def scratch():
            nonlocal SCR
            SCR = os.path.realpath(tempfile.mkdtemp(prefix="smoke-scratch-", dir=WORK))
            subprocess.run(["git", "init", "-q"], cwd=SCR, check=True)
            os.makedirs(os.path.join(SCR, ".claude"))
            cmd = "cat > '%s/stdin-scratch.json'; printf 'scratch-%s\\n'" % (RUN, M)
            with open(os.path.join(SCR, ".claude", "settings.json"), "w") as f:
                json.dump({"statusLine": {"type": "command", "command": cmd, "refreshInterval": 2}}, f)
            D = os.path.basename(SCR)

            def shows(lines, rows, c):
                return any("scratch-" + M in r and c["row"](nextrow(lines, rows, i)) for i, r in enumerate(rows))

            never = lambda l, rows, c: ["DUP"] if any(c["dup_row"](r) for r in rows) else []
            c = exec_case("scratch", "wrap", SCR, D, None, shows, never)
            ok = False
            for l in c["sl"]:
                m = re.search(r"/bin/statusline\S* wrap .*?([A-Za-z0-9+/=]{8,})'?\]", l)
                if m:
                    try:
                        ok = ok or __import__("base64").b64decode(m.group(1)).decode() == cmd
                    except Exception:
                        pass
            c["chk"]("launcher line ends in base64 of the scratch command", ok)
            c["chk"]("no StatusLine [cat > line", not any(l.startswith("cat >") for l in c["sl"]))
            c["chk"]("no Broken symlink line naming scratch settings", not any("Broken symlink" in l and l.rstrip().rstrip("'\"]").endswith(SCR + "/.claude/settings.json") for l in c["dl"]))
            c["chk"]("stdin captured", os.path.exists(os.path.join(RUN, "stdin-scratch.json")))
            c["extra"] = ["scratch: " + SCR]
            return c

        def nojq():
            nb = os.path.join(RUN, "nojq-bin")
            os.makedirs(nb)
            for d in os.environ.get("PATH", "").split(os.pathsep):
                try:
                    names = os.listdir(d)
                except OSError:
                    continue
                for n in names:
                    src = os.path.join(d, n)
                    if n != "jq" and not os.path.lexists(os.path.join(nb, n)) and os.path.isfile(src) and os.access(src, os.X_OK):
                        os.symlink(src, os.path.join(nb, n))
            env = clean_env()
            env["PATH"] = nb
            a = subprocess.run(["sh", "-c", "command -v jq"], env=env, capture_output=True, text=True).returncode
            b = subprocess.run(["sh", "-c", "command -v claude"], env=env, capture_output=True, text=True).returncode
            envf = os.path.join(RUN, "nojq-env.txt")
            prior = prior_file("prior-nojq.sh", "{ echo \"PATH=$PATH\"; command -v jq || echo 'jq: none'; } > '%s'\nprintf 'nojq-%s\\n'\n" % (envf, M))

            def shows(lines, rows, c):
                return any("nojq-" + M in r and re.fullmatch(r"breaks\d+", nextrow(lines, rows, i)) for i, r in enumerate(rows))

            never = lambda l, rows, c: ["ROW"] if any(c["row"](r) for r in rows) else []
            c = exec_case("nojq", "wrap", ROOT, D0, prior, shows, never, env=env)
            try:
                et = open(envf).read()
            except OSError:
                et = ""
            c["chk"]("pre-check: jq absent and claude found under child PATH", a != 0 and b == 0, "jq rc=%d claude rc=%d" % (a, b))
            c["chk"]("nojq-env.txt says jq: none", "jq: none" in et, et[:200])
            c["chk"]("launcher ran", launcher(c))
            c["chk"]("segment file seen", c["seen"] is not None)
            c["extra"] = ["nojq-env: " + et.replace("\n", " | ")[:300]]
            return c

        for name, fn in (("wrap-slow", wrap_slow), ("only", only), ("off", off), ("scratch", scratch), ("nojq", nojq)):
            run_case(name, fn)
        results.append(vok)
        for f in ("stdin-wrap.json", "stdin-scratch.json"):
            k = stdin_keys(os.path.join(RUN, f))
            keys.append("%s: %s" % (f, "missing" if k is None else "keys=%s; %s; basename(current_dir)==D: %s" % (
                ",".join(k[0]), ", ".join("%s=%s" % x for x in k[1].items()), k[2] == (D0 if "wrap" in f else (os.path.basename(SCR) if SCR else None)))))
    except Exception as e:
        body.append("failure: %r" % e)
        results.append(False)
    finally:
        kill_all(signal.SIGKILL)
        for sid in SIDS:
            cleanup(sid)
        if SCR:
            forget_project(SCR)
        for d in (SCR, RUN):
            if d:
                shutil.rmtree(d, ignore_errors=True)
    h1 = sha(st)
    hok = h0 == h1
    results.append(hok)
    out = head + ["## stdin keys"] + keys + body + val + ["## settings hash", "sha256 after: " + h1, "verdict: " + ("pass" if hok else "fail")]
    out += ["launcher carried: " + (carried[0][1] if len(carried) == 1 else "; ".join("%s %s" % x for x in carried)) if carried else "launcher carried: no case ran"]
    carried_ok = bool(carried) and all(r == "yes" for _, r in carried)
    ok = all(results) and len(results) == 7 and carried_ok
    out.append("smoke: " + ("pass" if ok else "fail"))
    with open(os.path.join(WORK, "smoke.md"), "w") as f:
        f.write("\n".join(out) + "\n")
    return 0 if ok else 1


def main():
    global WORK
    if len(sys.argv) != 2 or sys.argv[1] not in ("route", "smoke"):
        print("usage: pty_probe.py route|smoke", file=sys.stderr)
        return 2
    mode = sys.argv[1]
    WORK = tempfile.mkdtemp(prefix="nudgewhen-probe-")
    print("probe files: " + WORK, file=sys.stderr)
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s, on_signal)
    try:
        return route() if mode == "route" else smoke()
    except Exception as e:  # reason goes to the mode's md
        os.makedirs(WORK, exist_ok=True)
        with open(os.path.join(WORK, "probe.md" if mode == "route" else "smoke.md"), "w") as f:
            f.write("failure: %r\n%s: fail\n" % (e, "route-a" if mode == "route" else "smoke"))
        return 1


if __name__ == "__main__":
    sys.exit(main())
