#!/bin/zsh
# The wave's gate of record: build · test · typecheck · lint, serially, FORCED.
#
# Ruling 7 — turbo can serve FULL TURBO from a cache another worktree populated,
# so an unforced gate is a lie. Every target here runs with --force.
#
# Ruling 24 — the gate must be honest without a human reading it:
#   * per-target STATUS files; a missing or unwritten STATUS reads as FAILURE,
#     so a Ctrl-C or a crash mid-target can never pass;
#   * the run exits NON-ZERO if any target failed, and prints one verdict line
#     naming the failures;
#   * logs land in the evidence tree ONLY on an all-green run, as the LAST step.
#     A red run leaves the previous green logs untouched and writes its own logs
#     to a clearly-named failure directory instead, so nothing is lost and
#     nothing is overstated.
#
# Logs are written OUTSIDE the repo and copied in at the end. That ordering was
# once load-bearing (a tracked >1 MB log made `git diff` blow genui-bench's
# ENOBUFS trap mid-run); that bug is fixed at the call site now, and the
# ordering stays because atomicity wants it anyway.
#
# Usage: scripts/serial-gate.sh [evidence-dir]
#   evidence-dir defaults to docs/superpowers/evidence/2026-08-03-ui-redesign/gates

set -u

REPO=$(git rev-parse --show-toplevel)
TIP=$(git -C "$REPO" rev-parse HEAD)
BRANCH=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST=${1:-"$REPO/docs/superpowers/evidence/2026-08-03-ui-redesign/gates"}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/serial-gate-$STAMP-XXXXXX")

TARGETS=(build test typecheck lint)

run() {
  local name="$1"; shift
  # STATUS is written ONLY after the target settled. Its absence — a kill, a
  # crash, a full disk — is a failure by construction, never a silent pass.
  {
    echo "# $STAMP — branch $BRANCH @ $TIP"
    echo "# cwd: $REPO"
    echo "# argv: $*"
    echo
    ( cd "$REPO" && "$@" ) 2>&1
    # $? MUST be read on the very next line — a bare `echo` in between clobbers
    # it, which is exactly how an early run wrote EXIT=0 under a failing target.
    local code=$?
    echo
    echo "EXIT=$code"
    print -r -- "$code" > "$WORK/$name.status"
  } > "$WORK/$name.log" 2>&1
  tail -1 "$WORK/$name.log"
}

run build     pnpm build --force
run test      pnpm exec turbo run test test:ui --force --concurrency=1 --continue
run typecheck pnpm typecheck --force
# All three legs of the root `lint` script. `pnpm lint --force` would hand
# --force to dependency-guard.mjs instead of turbo, so the target is spelled out
# — the earlier gate spelled out only the turbo leg and silently skipped the
# dependency guard and the portability gate while reporting "lint EXIT=0".
run lint      zsh -c 'node scripts/dependency-guard.mjs && node scripts/portability-gate.mjs && pnpm exec turbo run lint --force'

# --- verdict -----------------------------------------------------------------

failed=()
for name in ${TARGETS[@]}; do
  # No status file, or a status that is not exactly 0, is a failure.
  if [[ ! -s "$WORK/$name.status" ]] || [[ "$(cat "$WORK/$name.status")" != "0" ]]; then
    failed+=("$name")
  fi
done

echo
echo "GATE $STAMP — branch $BRANCH @ $TIP"
for name in ${TARGETS[@]}; do
  if [[ -s "$WORK/$name.status" ]]; then
    printf '  %-10s EXIT=%s\n' "$name" "$(cat "$WORK/$name.status")"
  else
    printf '  %-10s NO STATUS (killed or never finished) — counted as FAILURE\n' "$name"
  fi
done

if (( ${#failed[@]} == 0 )); then
  # All green: the evidence tree is updated, as the last thing the run does.
  mkdir -p "$DEST"
  cp "$WORK"/*.log "$DEST"/
  # Which commit the gate of record actually covers. Without it, logs left by an
  # older green run read as if they were about today's tip.
  print -r -- "PASS 4/4 · $STAMP · branch $BRANCH @ $TIP" > "$DEST/VERDICT"
  echo "VERDICT: PASS (4/4) — logs copied to $DEST"
  grep -H "Cached:" "$DEST"/build.log "$DEST"/test.log "$DEST"/typecheck.log "$DEST"/lint.log
  exit 0
fi

# Red: the evidence tree is NOT touched. The logs go somewhere obviously named
# so the failure is inspectable and can never be mistaken for the gate of record.
FAILDIR="$REPO/.gate-failures/$STAMP"
mkdir -p "$FAILDIR"
cp "$WORK"/*.log "$WORK"/*.status "$FAILDIR"/ 2>/dev/null
echo "VERDICT: FAIL (${#failed[@]}/4 red: ${(j:, :)failed}) — $DEST NOT updated; logs in $FAILDIR"
exit 1
