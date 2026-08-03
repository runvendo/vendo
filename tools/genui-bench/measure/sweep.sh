#!/usr/bin/env bash
# One measurement sweep: every committed pack against BOTH hosts, vendo lane
# only, into `runs/_measure/<arm>/`. Packs run as parallel processes (one per
# host×pack); prompts inside a pack stay sequential, the way the CLI runs them.
#
#   measure/sweep.sh baseline
#
# The model key is sourced from the repo-root .env by the lane itself; when the
# worktree has no .env, export ANTHROPIC_API_KEY before calling.
set -euo pipefail

arm="${1:?usage: sweep.sh <arm-name>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/../runs/_measure/$arm"
mkdir -p "$out"

pids=()
for host in maple cadence; do
  for pack in "$here"/../packs/*.json; do
    name="$(basename "$pack" .json)"
    (cd "$here/.." && pnpm bench run --host "$host" --pack "$name" --lanes vendo --runs-dir "$out" \
      >"$out/.log-$host-$name.txt" 2>&1) &
    pids+=($!)
  done
done

fail=0
for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
echo "sweep '$arm' done (exit-fail=$fail) -> $out"
exit "$fail"
