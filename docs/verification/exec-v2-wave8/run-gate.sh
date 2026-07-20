#!/bin/bash
# Wave 8 live-gate runner — detached-friendly (launchd/tmux): sets PATH, loads
# keys from Infisical, writes the transcript beside this script.
set -u
# One-shot guard: a completed gate leaves the marker; launchd restarts become no-ops.
[ -f "/Users/yousefh/orca/workspaces/flowlet/exec-wave8-sdk/docs/verification/exec-v2-wave8/gate-done.marker" ] && exit 0
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd /Users/yousefh/orca/workspaces/flowlet/exec-wave8-sdk
D=docs/verification/exec-v2-wave8
set -a
eval "$(cd /Users/yousefh/orca/workspaces/flowlet && infisical export --format=dotenv-export 2>/dev/null | grep -E '^export (E2B_API_KEY|ANTHROPIC_API_KEY)=')"
set +a
STAMP=$(date +%s)
node --trace-uncaught "$D/live-gate.mjs" --template pbgk5vxvhmtjmcn8lgeo > "$D/live-gate-transcript-$STAMP.txt" 2>&1
echo "exit=$?" >> "$D/live-gate-transcript-$STAMP.txt"
cp "$D/live-gate-transcript-$STAMP.txt" "$D/live-gate-transcript.txt"
touch "$D/gate-done.marker"
