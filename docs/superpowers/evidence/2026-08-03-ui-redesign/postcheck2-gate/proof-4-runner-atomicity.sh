#!/bin/zsh
# Reproducible demonstration of scripts/serial-gate.sh's atomicity + verdict
# rules, with instant stand-in targets so the four scenarios cost seconds
# instead of four full monorepo gates.
set -u
GATE=$1
D=$(mktemp -d "${TMPDIR:-/tmp}/serial-gate-demo-XXXX")
cd "$D"
git init -q . && git config user.email demo@vendo.run && git config user.name demo
echo x > f && git add f && git commit -qm seed
mkdir -p scripts docs/superpowers/evidence/2026-08-03-ui-redesign/gates
EV=docs/superpowers/evidence/2026-08-03-ui-redesign/gates
fake() {
  sed -e "s#^run build .*#run build     $1#" \
      -e "s#^run test .*#run test      $2#" \
      -e "s#^run typecheck .*#run typecheck $3#" \
      -e "s#^run lint .*#run lint      $4#" "$GATE" > scripts/g.sh
  chmod +x scripts/g.sh
}

echo "=============================================================="
echo "A. ALL GREEN — evidence tree updated as the LAST step"
echo "=============================================================="
echo "STALE-GREEN-FROM-A-PREVIOUS-RUN" > "$EV/build.log"
fake true true true true
./scripts/g.sh; echo "exit=$?"
echo "-- $EV/build.log now:"; head -3 "$EV/build.log"
echo "-- $EV/VERDICT:"; cat "$EV/VERDICT"

echo
echo "=============================================================="
echo "B. ONE TARGET RED — non-zero exit, named verdict, evidence NOT touched"
echo "=============================================================="
cp "$EV/build.log" /tmp/demo-green-build.log
fake true true false true
./scripts/g.sh; echo "exit=$?"
echo "-- evidence build.log unchanged from the green run:"
diff -q "$EV/build.log" /tmp/demo-green-build.log && echo "   IDENTICAL (not overwritten)"
echo "-- failure logs written elsewhere:"; ls .gate-failures/*/

echo
echo "=============================================================="
echo "C. TORN RUN — a target that never wrote its STATUS reads as FAILURE"
echo "=============================================================="
fake true true true true
# Suppress typecheck's status write: exactly what a kill mid-target leaves behind.
sed -i '' 's#print -r -- "\$code" > "\$WORK/\$name.status"#[[ "$name" == typecheck ]] || print -r -- "$code" > "$WORK/$name.status"#' scripts/g.sh
./scripts/g.sh; echo "exit=$?"

echo
echo "=============================================================="
echo "D. ABORTED MID-TARGET (SIGTERM, i.e. Ctrl-C) — nothing is written at all"
echo "=============================================================="
fake true true "sleep 20" true
echo "PASS 4/4 · OLD-RUN-STAMP · branch main @ deadbeefdeadbeef" > "$EV/VERDICT"
./scripts/g.sh & GP=$!
sleep 4
kill -TERM $GP
wait $GP; echo "exit=$? (143 = SIGTERM)"
echo "-- evidence VERDICT still names the OLD run, so nothing reads as current:"
cat "$EV/VERDICT"
echo
echo "demo tree: $D"
