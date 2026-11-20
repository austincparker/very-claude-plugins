#!/bin/sh
# Runs the Stop command from hooks.json through sh: it must write nothing without NUDGEWHEN_IDLE_DIR, and with it
# a mode 600 nudgewhen-idle-<session>.json (the name idle.ts reads), and leave nothing behind on a payload with no session id.
# The plugin test runner cannot start processes, so run this by hand: sh tests/stop-hook.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cmd=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["hooks"]["Stop"][0]["hooks"][0]["command"])' "$here/../hooks/hooks.json")
grep -q "NUDGEWHEN_IDLE_DIR" "$here/../hooks/idle.ts"
grep -q -F "nudgewhen-idle-\${idle.sessionId}.json" "$here/../hooks/idle.ts"
# The shipped skill's name must match its directory, and the runtime test's plugin command must be <plugin>:<skill name>.
skill_dir="$here/../skills"
[ "$(ls "$skill_dir" | wc -l | tr -d ' ')" = "1" ] || { echo "FAIL: expected one skill in $skill_dir" >&2; exit 1; }
skill=$(ls "$skill_dir")
grep -q "^name: $skill\$" "$skill_dir/$skill/SKILL.md" || { echo "FAIL: SKILL.md name is not $skill" >&2; exit 1; }
case "$skill" in *-nudge) ;; *) echo "FAIL: skill $skill is not named <descriptor>-nudge" >&2; exit 1 ;; esac
plugin=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$here/../.claude-plugin/plugin.json")
grep -q -F "Use the $plugin:$skill skill now." "$skill_dir/$skill/SKILL.md" || { echo "FAIL: SKILL.md description lacks the prompt for $plugin:$skill" >&2; exit 1; }
grep -q -F "name: '$plugin:$skill'" "$here/idle.test.ts" || { echo "FAIL: idle.test.ts has no command $plugin:$skill" >&2; exit 1; }
# The version in plugin.json is the top CHANGELOG entry; the idle-check fallback goes in 0.4.0.
version=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$here/../.claude-plugin/plugin.json")
top=$(sed -n 's/^## \[\(.*\)\].*/\1/p' "$here/../CHANGELOG.md" | head -1)
[ "$top" = "$version" ] || { echo "FAIL: plugin.json $version, CHANGELOG top $top" >&2; exit 1; }
minor=$(printf '%s' "$version" | cut -d. -f2)
major=$(printf '%s' "$version" | cut -d. -f1)
if [ "$major" -gt 0 ] || [ "$minor" -ge 4 ]; then
  ! grep -q "LEGACY_COMMAND" "$here/../hooks/idle.ts" || { echo "FAIL: the idle-check fallback was due out in 0.4.0" >&2; exit 1; }
fi
# When this CLI has it, the supported check that the manifest and skill frontmatter parse.
if command -v claude >/dev/null 2>&1 && claude plugin validate --help >/dev/null 2>&1; then
  claude plugin validate "$here/.." >/dev/null || { echo "FAIL: claude plugin validate" >&2; exit 1; }
fi
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
