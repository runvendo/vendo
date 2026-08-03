#!/bin/bash
# Wave 8 A/B + env-shape driver — detached runner (survives session restarts).
# Outputs land beside this script as out-*.txt; out-driver-done.txt marks completion.
set -u
cd "$(dirname "$0")/../../.."
D=docs/verification/exec-v2-wave8
SDK_T=pbgk5vxvhmtjmcn8lgeo
THIN_T=02ar6qdzqils9e3hgek5

set -a
eval "$(cd /Users/yousefh/orca/workspaces/flowlet && infisical export --format=dotenv-export 2>/dev/null | grep -E '^export (E2B_API_KEY|ANTHROPIC_API_KEY|OSS_CONFORMANCE_VENDO_API_KEY)=')"
export VENDO_API_KEY="${OSS_CONFORMANCE_VENDO_API_KEY:-}"
set +a

# Stage 1: both env shapes, headless in-sandbox.
node "$D/smoke-env-shapes.mjs" --template "$SDK_T" --shape byo     > "$D/out-smoke-byo.txt" 2>&1 &
node "$D/smoke-env-shapes.mjs" --template "$SDK_T" --shape gateway > "$D/out-smoke-gateway.txt" 2>&1 &
wait

# Stage 2: layer-3 A/B, run 2 (run 1 logs already captured).
node "$D/measure-box-build.mjs" --template "$THIN_T" --label thin-l3-2 --mode layer3 > "$D/out-thin-l3-2.txt" 2>&1 &
node "$D/measure-box-build.mjs" --template "$SDK_T"  --label sdk-l3-2  --mode layer3 > "$D/out-sdk-l3-2.txt" 2>&1 &
wait

# Stage 3: graduation-edit A/B, run 1.
node "$D/measure-box-build.mjs" --template "$THIN_T" --label thin-grad-1 --mode graduation > "$D/out-thin-grad-1.txt" 2>&1 &
node "$D/measure-box-build.mjs" --template "$SDK_T"  --label sdk-grad-1  --mode graduation > "$D/out-sdk-grad-1.txt" 2>&1 &
wait

# Stage 4: graduation-edit A/B, run 2.
node "$D/measure-box-build.mjs" --template "$THIN_T" --label thin-grad-2 --mode graduation > "$D/out-thin-grad-2.txt" 2>&1 &
node "$D/measure-box-build.mjs" --template "$SDK_T"  --label sdk-grad-2  --mode graduation > "$D/out-sdk-grad-2.txt" 2>&1 &
wait

echo "done $(date -u +%FT%TZ)" > "$D/out-driver-done.txt"
