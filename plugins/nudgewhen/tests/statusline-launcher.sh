#!/bin/sh
# Tests for bin/statusline. Run from anywhere: sh plugins/nudgewhen/tests/statusline-launcher.sh
# POSIX sh only; works under dash and macOS /bin/sh.

here=$(cd "$(dirname "$0")" && pwd)
L=$here/../bin/statusline
T=$(mktemp -d "${TMPDIR:-/tmp}/nw-statusline.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
trap 'exit 1' INT TERM

fails=0
n=0
SEP='  ·  '
ESC=$(printf '\033')
TAB=$(printf '\t')

check() { name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
pass() { n=$((n + 1)); printf 'ok %s - %s\n' "$n" "$1"; }
fail() { n=$((n + 1)); fails=$((fails + 1)); printf 'not ok %s - %s\n' "$n" "$1"; }
# expect <name> <expected> <actual>
expect() {
  if [ "$2" = "$3" ]; then pass "$1"; else
    fail "$1"
    printf '#   expected: %s\n#   actual:   %s\n' "$2" "$3"
  fi
}
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
now_ms() { printf '%s000' "$(date +%s)"; }
old_ms() { printf '%s000' "$(($(date +%s) - 300))"; }

state=$T/state
mkdir -p "$state"
json='{"session_id":"s1","cwd":"/w/proj","effort":{"level":"high"}}'

# seg <sid> <ms> <list> [name<TAB>text ...]
seg() {
  f=$state/$1.txt
  printf 'v1 %s\n%s\n' "$2" "$3" >"$f"
  shift 3
  for line in "$@"; do printf '%s\n' "$line" >>"$f"; done
}
# run <mode> <b64> [state dir]: launcher stdout in $out, status in $rc; stdin from $json
run() {
  out=$(printf '%s' "$json" | "$L" "$1" "${3-$state}" "$2")
  rc=$?
}
reset() { rm -rf "$state"; mkdir -p "$state"; }

check 'launcher is executable' [ -x "$L" ]

# --- wrap: prior rows first with SGR resets, then the row in file order ---
reset
seg s1 "$(now_ms)" 'model,sit' "sit${TAB}sat 5m" "model${TAB}opus"
run wrap "$(b64 'printf "row1\nrow2\n"')"
expect 'wrap prints prior rows with resets, then the row in file order' \
  "row1${ESC}[0m
row2${ESC}[0m
opus${SEP}sat 5m" "$out"
expect 'wrap exits 0' 0 "$rc"

# --- prior sees the same stdin and cwd ---
reset
seg s1 "$(now_ms)" 'sit' "sit${TAB}x"
mkdir -p "$T/cwd"
out=$(cd "$T/cwd" && printf '%s' "$json" | "$L" wrap "$state" "$(b64 'cat; pwd')")
case $out in
  *"$json"*) pass 'prior receives the stdin JSON' ;;
  *) fail 'prior receives the stdin JSON' ;;
esac
case $out in
  *"$(cd "$T/cwd" && pwd)"*) pass 'prior runs in the same cwd' ;;
  *) fail 'prior runs in the same cwd' ;;
esac

# --- .prior is written ---
reset
seg s1 "$(now_ms)" 'sit' "sit${TAB}x"
run wrap "$(b64 'echo cached-row')"
expect '.prior holds the last good output' 'cached-row' "$(cat "$state/s1.prior")"

# --- a prior command that sleeps 3 s: bounded, cache shown and unchanged ---
reset
seg s1 "$(now_ms)" 'sit' "sit${TAB}x"
printf 'good\n' >"$state/s1.prior"
start=$(date +%s)
run wrap "$(b64 'sleep 3; echo late')"
end=$(date +%s)
check 'sleeping prior returns in under 3 s' [ $((end - start)) -lt 3 ]
expect 'sleeping prior shows the cached rows' "good${ESC}[0m
x" "$out"
expect 'sleeping prior leaves the cache unchanged' good "$(cat "$state/s1.prior")"
expect 'sleeping prior leaves no temp file' 2 "$(find "$state" -type f | wc -l | tr -d ' ')"

# --- prior exiting 1 shows the cache ---
reset
seg s1 "$(now_ms)" 'sit' "sit${TAB}x"
printf 'good\n' >"$state/s1.prior"
run wrap "$(b64 'echo bad; exit 1')"
expect 'failing prior shows the cache' "good${ESC}[0m
x" "$out"
expect 'failing prior leaves the cache unchanged' good "$(cat "$state/s1.prior")"

# --- only never runs the prior ---
reset
seg s1 "$(now_ms)" 'sit' "sit${TAB}x"
run only "$(b64 "touch '$T/marker'; echo p")"
expect 'only prints just the row' x "$out"
check 'only never runs the prior' [ ! -e "$T/marker" ]
rm -f "$T/marker"
run bogus "$(b64 "touch '$T/marker'; echo p")"
check 'an unknown mode behaves like only' [ ! -e "$T/marker" ]

# --- `-` prior ---
reset
seg s1 "$(now_ms)" 'sit' "sit${TAB}x"
run wrap -
expect 'a - prior prints just the row' x "$out"

# --- stdin segments through jq ---
reset
json='{"session_id":"s1","cwd":"/a/b","workspace":{"current_dir":"/w/proj","git_worktree":"wt"},"effort":{"level":"high"},"fast_mode":true,"vim":{"mode":"NORMAL"},"pr":{"number":7,"review_state":"approved"},"output_style":{"name":"learning"},"cost":{"total_lines_added":3,"total_lines_removed":1}}'
seg s1 "$(now_ms)" 'effort,fast,vim,pr,style,worktree,dir,lines,sit' "sit${TAB}x"
if command -v jq >/dev/null; then
  run only -
  expect 'jq fills the stdin segments' "effort high${SEP}fast${SEP}vim NORMAL${SEP}PR #7 approved${SEP}learning${SEP}wt${SEP}proj${SEP}+3 -1${SEP}x" "$out"
  json='{"session_id":"s1","pr":{"number":9,"kind":"mr"},"output_style":{"name":"default"},"cost":{"total_lines_added":0,"total_lines_removed":0},"cwd":"/q/r"}'
  run only -
  expect 'mr, default style, zero lines and cwd fallback' "MR !9${SEP}r${SEP}x" "$out"
else
  pass 'jq not installed: stdin segment cases skipped'
fi

# --- no jq on PATH: stdin segments dropped, file segments kept ---
json='{"session_id":"s1","cwd":"/a/b","effort":{"level":"high"},"fast_mode":true}'
nobin=$T/nojq
mkdir -p "$nobin"
for t in cat tr sed head awk date mkdir mv rm sleep base64 dirname; do
  p=$(command -v "$t") && ln -sf "$p" "$nobin/$t"
done
reset
seg s1 "$(now_ms)" 'effort,sit,dir,fast,model' "sit${TAB}x" "model${TAB}m"
out=$(printf '%s' "$json" | PATH=$nobin "$L" wrap "$state" "$(b64 'echo p')")
rc=$?
expect 'without jq the stdin segments drop and file segments stay' "p${ESC}[0m
x${SEP}m" "$out"
expect 'without jq it exits 0' 0 "$rc"

# --- stale and missing file ---
json='{"session_id":"s1","effort":{"level":"high"}}'
reset
seg s1 "$(old_ms)" 'effort,sit' "sit${TAB}x"
run wrap "$(b64 'echo p')"
expect 'a stale file hides the whole row but keeps prior rows' "p${ESC}[0m" "$out"
seg s1 "$(($(date +%s) + 500))000" 'sit' "sit${TAB}x"
run only -
expect 'a stamp far in the future is stale' '' "$out"
reset
run only -
expect 'a missing file prints nothing' '' "$out"
expect 'a missing file exits 0' 0 "$rc"

# --- bad v line ---
for bad in 'v2 1' 'v1' 'v1 abc' 'v1 12x4' 'x'; do
  printf '%s\nsit\nsit\tx\n' "$bad" >"$state/s1.txt"
  run only -
  expect "bad first line '$bad' prints nothing" '' "$out"
done

# --- empty text and unknown names ---
reset
seg s1 "$(now_ms)" ',sit,,ghost, blank ,model,' "sit${TAB}x" "blank${TAB}" "model${TAB}m"
run only -
expect 'empty text and unknown names leave no doubled separators' "x${SEP}m" "$out"
seg s1 "$(now_ms)" 'ghost' "sit${TAB}x"
run only -
expect 'a row of nothing prints nothing' '' "$out"

# --- session id with path characters reads nothing ---
reset
seg s1 "$(now_ms)" 'sit' "sit${TAB}x"
printf 'v1 %s\nsit\nsit\tleak\n' "$(now_ms)" >"$T/x.txt"
json='{"session_id":"../x"}'
run only -
expect 'session id ../x reads nothing' '' "$out"
json='{"cwd":"/x"}'
run wrap "$(b64 'echo p')"
expect 'no session id still prints prior output, no row' "p${ESC}[0m" "$out"

# --- minimal JSON ---
json='{"session_id":"s1"}'
seg s1 "$(now_ms)" 'effort,dir,sit' "sit${TAB}x"
run wrap "$(b64 'echo p')"
expect 'minimal JSON prints the file segments only' "p${ESC}[0m
x" "$out"

# --- quotes in the prior command ---
reset
seg s1 "$(now_ms)" 'sit' "sit${TAB}x"
run wrap "$(b64 "echo \"it's \$HOME\" 'a\"b'")"
expect 'quotes in the prior command survive' "it's $HOME a\"b${ESC}[0m
x" "$out"

# --- missing state dir is created ---
json='{"session_id":"s1"}'
run wrap "$(b64 'echo p')" "$T/new/deep/state"
expect 'a missing state dir is created and the prior is cached' p "$(cat "$T/new/deep/state/s1.prior")"
expect 'missing state dir exits 0' 0 "$rc"

# --- state dir that cannot be created: carries on ---
: >"$T/file"
run wrap "$(b64 'echo p')" "$T/file/sub"
expect 'an uncreatable state dir still prints the prior' "p${ESC}[0m" "$out"
expect 'an uncreatable state dir exits 0' 0 "$rc"

# --- always exits 0 ---
for args in '' 'wrap' 'wrap /nonexistent/x !!!notbase64' 'wrap . -'; do
  # shellcheck disable=SC2086
  printf 'not json' | "$L" $args >/dev/null
  expect "exits 0 for args '$args' with garbage stdin" 0 "$?"
done

printf '# %s tests, %s failed\n' "$n" "$fails"
[ "$fails" -eq 0 ]
