#!/bin/sh
# Runs the Stop command from hooks.json through sh: it must write nothing without NUDGEWHEN_IDLE_DIR, and with it
# a mode 600 nudgewhen-idle-<session>.json (the name idle.ts reads), and leave nothing behind on a payload with no session id.
# The plugin test runner cannot start processes, so run this by hand: sh tests/stop-hook.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cmd=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["hooks"]["Stop"][0]["hooks"][0]["command"])' "$here/../hooks/hooks.json")
grep -q "NUDGEWHEN_IDLE_DIR" "$here/../hooks/idle.ts"
grep -q -F "nudgewhen-idle-\${idle.sessionId}.json" "$here/../hooks/idle.ts"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

printf '%s' '{"session_id":"sess-1","background_tasks":[]}' | env -u NUDGEWHEN_IDLE_DIR sh -c "$cmd"
[ -z "$(ls -A "$dir")" ] || fail "wrote without NUDGEWHEN_IDLE_DIR"

printf '%s' '{"session_id":"sess-1","background_tasks":[]}' | NUDGEWHEN_IDLE_DIR="$dir" sh -c "$cmd"
[ "$(ls "$dir")" = "nudgewhen-idle-sess-1.json" ] || fail "report name: $(ls "$dir")"
mode=$(stat -f %Lp "$dir/nudgewhen-idle-sess-1.json" 2>/dev/null || stat -c %a "$dir/nudgewhen-idle-sess-1.json")
[ "$mode" = "600" ] || fail "mode $mode"
grep -q '"session_id":"sess-1"' "$dir/nudgewhen-idle-sess-1.json" || fail "report body"

printf '%s' 'not json' | NUDGEWHEN_IDLE_DIR="$dir" sh -c "$cmd"
[ "$(ls -A "$dir")" = "nudgewhen-idle-sess-1.json" ] || fail "left a temp file: $(ls -A "$dir")"
echo "stop-hook: ok"
