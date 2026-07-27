set -u
ROOT="/Users/yousefh/orca/workspaces/flowlet/demo-zero-friction"
OUT="$ROOT/docs/verification/demo-live-readiness/zero-friction/host-binding-probe.txt"

cd "$ROOT/apps/demo-bank"
DEMO_AUTOLOGIN=1 VENDO_BASE_URL=http://127.0.0.1:4300 AUTH_SECRET=zero-friction-proof-secret \
  MAPLE_DEMO_PASSWORD=maple-harvest-0427 NEXT_TELEMETRY_DISABLED=1 \
  node_modules/.bin/next start -p 4300 > /tmp/maple-matrix2.log 2>&1 &
MAPLE=$!
cd "$ROOT/apps/demo-accounting"
env -u SUPABASE_URL -u SUPABASE_ANON_KEY -u SUPABASE_JWT_SECRET \
  DEMO_AUTOLOGIN=1 VENDO_BASE_URL=http://127.0.0.1:4301 NEXT_TELEMETRY_DISABLED=1 \
  node_modules/.bin/next start -p 4301 > /tmp/cadence-matrix2.log 2>&1 &
CADENCE=$!
trap 'kill $MAPLE $CADENCE 2>/dev/null' EXIT
until curl -sf -o /dev/null http://127.0.0.1:4300/ && curl -sf -o /dev/null http://127.0.0.1:4301/; do sleep 2; done

probe() { # port path label curl-args...
  local port="$1" path="$2" label="$3"; shift 3
  local out; out=$(curl -s -D - -o /dev/null "$@" "http://127.0.0.1:$port$path")
  if printf '%s' "$out" | grep -qi "^set-cookie"; then printf 'MINTED   '; else printf 'no-mint  '; fi
  printf '%s\n' "$label"
}

run_host() { # port path
  local p="$1" q="$2" H="127.0.0.1:$1"
  probe "$p" "$q" "Host: $H  (the configured authority)" -H "Host: $H"
  probe "$p" "$q" "Host: $H  + X-Forwarded-Host: $H  (edge agreement)" -H "Host: $H" -H "X-Forwarded-Host: $H"
  probe "$p" "$q" "Host: $H  + X-Forwarded-Host: victim.example  (disagreement)" -H "Host: $H" -H "X-Forwarded-Host: victim.example"
  probe "$p" "$q" "Host: victim.example + X-Forwarded-Host: $H  (XFH spoof)" -H "Host: victim.example" -H "X-Forwarded-Host: $H"
  probe "$p" "$q" "Host: $H  + Host: victim.example, no XFH  (duplicate; Node keeps the FIRST and drops the rest, so the app sees only the configured value — ACCEPTED RESIDUAL)" -H "Host: $H" -H "Host: victim.example"
  probe "$p" "$q" "Host: $H  + Host: victim.example + X-Forwarded-Host: victim.example  (upstream routed on the smuggled value — the agreement check catches it)" -H "Host: $H" -H "Host: victim.example" -H "X-Forwarded-Host: victim.example"
  probe "$p" "$q" "Host: $H, victim.example  (comma-joined duplicate)" -H "Host: $H, victim.example"
  probe "$p" "$q" "Host: victim.example@$H  (userinfo)" -H "Host: victim.example@$H"
  probe "$p" "$q" "Host: $H#victim.example  (fragment)" -H "Host: $H#victim.example"
  probe "$p" "$q" "Host: $H/victim.example  (path)" -H "Host: $H/victim.example"
  probe "$p" "$q" "Host: $H?victim.example  (query)" -H "Host: $H?victim.example"
  probe "$p" "$q" "Host: $H:$1  (double colon)" -H "Host: $H:$1"
  probe "$p" "$q" "Host: [127.0.0.1]:$1  (brackets)" -H "Host: [127.0.0.1]:$1"
  probe "$p" "$q" "Host: 127..0.0.1:$1  (empty label)" -H "Host: 127..0.0.1:$1"
  probe "$p" "$q" "Host: 127.0.0.1:9999  (wrong port)" -H "Host: 127.0.0.1:9999"
}

{
  echo "Live host-binding matrix — prod builds, DEMO_AUTOLOGIN=1,"
  echo "VENDO_BASE_URL=http://127.0.0.1:4300 (Maple) / :4301 (Cadence). 2026-07-26."
  echo "Only the exact configured authority may mint, and any X-Forwarded-Host"
  echo "present must agree with Host after the same normalization."
  echo
  echo "On duplicate Host fields, Node keeps the FIRST and discards the rest --"
  echo "the app cannot see the others, so it decides on the value it has. The"
  echo "case that matters (an upstream hop routing on a different value) is"
  echo "caught by the X-Forwarded-Host agreement check, which Railway's edge"
  echo "always populates. See notes.md, \"accepted residual\"."
  echo
  echo "--- Maple (:4300, /accounts) ---"
  run_host 4300 /accounts
  echo
  echo "--- Cadence (:4301, /clients) ---"
  run_host 4301 /clients
  echo
  echo "Server-side refusal warning (logged once per process):"
  grep -h "does not match the configured demo origin" /tmp/maple-matrix2.log /tmp/cadence-matrix2.log | head -2
} > "$OUT"
cat "$OUT"
