#!/bin/sh
# Runs the Stop command from hooks.json through sh: it must write nothing without NUDGEWHEN_IDLE_DIR, and with it
# a mode 600 nudgewhen-idle-<session>.json (the name idle.ts reads), and leave nothing behind on a payload with no session id.
# The plugin test runner cannot start processes, so run this by hand: sh tests/stop-hook.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cmd=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["hooks"]["Stop"][0]["hooks"][0]["command"])' "$here/../hooks/hooks.json")
grep -q "NUDGEWHEN_IDLE_DIR" "$here/../hooks/idle.ts"
grep -q -F "nudgewhen-idle-\${idle.sessionId}.json" "$here/../hooks/idle.ts"
# The shipped skill's directory and name must match pluginNudgeCommand('idle') in idle.ts.
grep -q '^name: idle-nudge$' "$here/../skills/idle-nudge/SKILL.md"
grep -q "pluginNudgeCommand(DESCRIPTOR)" "$here/../hooks/idle.ts"
grep -q "^const DESCRIPTOR = 'idle'" "$here/../hooks/idle.ts"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

printf '%s' '{"session_id":"sess-1","background_tasks":[]}' | env -u NUDGEWHEN_IDLE_DIR sh -c "$cmd"
[ -z "$(ls -A "$dir")" ] || fail "wrote without NUDGEWHEN_IDLE_DIR"

printf '%s' '{"session_id":"sess-1","background_tasks":[]}' | NUDGEWHEN_IDLE_DIR="$dir" sh -c "$cmd"
[ "$(ls "$dir")" = "nudgewhen-idle-sess-1.json" ] || fail "report name: $(ls "$dir")"
mode=$(python3 -I -c 'import os,sys; print(format(os.stat(sys.argv[1]).st_mode & 0o777, "o"))' "$dir/nudgewhen-idle-sess-1.json")
[ "$mode" = "600" ] || fail "mode $mode"
grep -q '"session_id":"sess-1"' "$dir/nudgewhen-idle-sess-1.json" || fail "report body"

printf '%s' '{"background_tasks":[{"session_id":"nested-9"}],"session_id":"sess-2"}' | NUDGEWHEN_IDLE_DIR="$dir" sh -c "$cmd"
[ -f "$dir/nudgewhen-idle-nested-9.json" ] && fail "named by a nested session_id"
rm -f "$dir/nudgewhen-idle-sess-2.json"

printf '%s' '{"session_id":"sess-1","stop_hook_active":true,"marker":"active"}' | NUDGEWHEN_IDLE_DIR="$dir" sh -c "$cmd"
! grep -q marker "$dir/nudgewhen-idle-sess-1.json" || fail "a stop_hook_active stop overwrote the report"

printf '%s' 'not json' | NUDGEWHEN_IDLE_DIR="$dir" sh -c "$cmd"
[ "$(ls -A "$dir")" = "nudgewhen-idle-sess-1.json" ] || fail "left a temp file: $(ls -A "$dir")"
echo "stop-hook: ok"
