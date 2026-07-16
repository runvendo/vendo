---
name: demo-creator
description: Build, verify, and deploy a bespoke Vendo demo for a prospect, then iMessage Yousef the link + GIF for his review. Use when the founder says "make a demo for <prospect>", "demo <company>", "build a <company> demo", or an outreach thread needs a bespoke demo. This skill NEVER contacts the prospect — it reports to Yousef only, and he forwards the demo himself.
user-invocable: true
allowed-tools: Bash, Read
argument-hint: <prospect name> + URL and/or screenshot paths [+ notes]
---

# Demo Creator

Turn "make a demo for <prospect>" into a verified, deployed demo at
`demos.vendo.run/<id>`, then hand Yousef ONE iMessage with the link + GIF +
verification summary and STOP.

**HARD RULE (read this twice — it is repeated at the bottom): this skill never
contacts a prospect.** No email, no LinkedIn, no DM, no calendar invite,
nothing outbound to anyone but Yousef. The deliverable is a report to Yousef;
he reviews and forwards the demo himself. Deploying to demos.vendo.run is
allowed (the link is unlisted); *sending* that link to anyone but Yousef is
not.

This skill is a thin driver. The actual build contract is
`bench/demo-creator/PLAYBOOK.md` in the Vendo repo (with
`apps/demo-template/VERIFY.md` as the definition of done); a creator session
executes it in an Orca workspace while this skill spawns, waits, deploys, and
reports.

## Inputs

- **Prospect name** (display name, e.g. "Linear") — required.
- **Prospect URL** and/or **screenshot paths** of their product — at least
  one; both is better. Screenshots are the high-fidelity path for gated
  dashboards.
- Optional notes: which beat vocabulary / product surface to use, CTA link
  override (`--cta-url`), expiry window.

Derive the slug yourself: lowercase alphanumeric segments joined by single
hyphens (e.g. "Acme Corp" → `acme-corp`).

## Step 0 — Preconditions (once per machine, cheap to re-check)

- The Vendo repo checkout is registered with Orca: `orca repo list --json`
  (register once with `orca repo add --path <vendo checkout> --json`).
- `node --version` in that checkout is **>= 23.6** (the demo-creator CLI
  loads the template's TypeScript schema via type stripping).
- Secrets present:
  - `ANTHROPIC_API_KEY` in the canonical env file
    `/Users/yousefh/orca/workspaces/flowlet/.env` (synced from the dev
    machine once, manually).
  - Router admin token at `~/.vendo/demo-router-admin-token`.
- `railway` CLI installed and logged in; `ffmpeg`/`ffprobe` on PATH.

## Step 1 — Spawn the creator session (orca-cli)

Write the session prompt to a file first (never inline backticks into
`--prompt`), then create the workspace:

```bash
cat > /tmp/demo-<slug>-prompt.md <<'EOF'
You are a demo-creator session. Follow bench/demo-creator/PLAYBOOK.md in this
repo end to end; apps/demo-template/VERIFY.md is the definition of done.

Prospect: <Name>
URL: <https://prospect-site or "none — screenshots only">
Screenshots: <absolute paths, or "none — URL only"> (copy them into the app's RESEARCH/ dir)
Notes: <beat vocabulary / surface hints / CTA override / "none">
Demo id: <slug>

Do NOT deploy, do NOT commit anything, and do NOT contact anyone.
End your run with exactly one final report line, either:
  VERIFIED: apps/demo-<slug> — manifest at bench/demo-capture/output/<slug>-verify/MANIFEST.md
  FAILED-ESCALATE: <one-line cause> — evidence: <capture.json + GIF paths, what was tried>
EOF

orca worktree create --repo id:<vendoRepoId> --name demo-<slug> \
  --agent claude --prompt "$(cat /tmp/demo-<slug>-prompt.md)" --json
```

One session per prospect, sequential — don't run two creator sessions at
once (they contend for capture ports and the shared port-3000 lock).

## Step 2 — Wait for VERIFIED / FAILED-ESCALATE

A run takes roughly 20–40 minutes. Poll with tui-idle waits and read the
tail until the report line appears:

```bash
orca terminal list --worktree branch:demo-<slug> --json    # get the handle
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 600000 --json
orca terminal read --terminal <handle> --json              # look for VERIFIED: / FAILED-ESCALATE:
```

Repeat the wait+read loop while the session is still working. Never
fabricate the outcome; if the session asks a question, answer from the
inputs or escalate to Yousef.

- **FAILED-ESCALATE** → skip deploy. iMessage Yousef the failure evidence
  (cause line, `capture.json` + GIF paths, what was tried) and stop.

## Step 3 — Deploy (only on VERIFIED)

Run from the creator session's worktree root (the demo app is an untracked
scratch app that only exists there — `orca worktree show --worktree
branch:demo-<slug> --json` gives the path):

```bash
cd <worktree path>
set -a; source /Users/yousefh/orca/workspaces/flowlet/.env; set +a   # ANTHROPIC_API_KEY
export ROUTER_ADMIN_TOKEN="$(cat ~/.vendo/demo-router-admin-token)"
pnpm --filter @vendoai/bench demo:deploy -- --app apps/demo-<slug>
```

What it does: renders a Dockerfile + .dockerignore into the app, syncs the
lockfile, creates/updates the `demo-<slug>` service in Railway project
`vendo-demos`, sets `ANTHROPIC_API_KEY` on the service, `railway up`s the
working tree, then registers the demo with the demos.vendo.run router. It
prints `Live at https://demos.vendo.run/<id>` on success. Neither secret is
ever logged. `--dry-run` prints the plan without executing.

## Step 4 — Report to Yousef (ONE iMessage via agent-notify)

Plain text, no markdown, one message. Pull the numbers from the run's
`MANIFEST.md` and `capture.json` (per-beat `overlay` marks — `firstPaintMs`,
`usableMs`, `elapsedMs` — plus `approvals`):

```
Demo ready for <Prospect> — review before anything goes out.
Link: https://demos.vendo.run/<id> (expires <expiresAt>)
GIF: <absolute path to demo-beats-<id>.gif>
Beats:
- generate-ui: view rendered, usable <n>s
- take-action: consent card shown + approved, usable <n>s
- save-app: settled clean
Fidelity (1-5): palette <n>, typography <n>, layout <n>, voice <n>
Spend: ~$<verification-run estimate>; live caps <maxTurns> turns / $<maxSpendUsd>, expires <date>
Reply "approve" to green-light outreach, or "fix: <notes>".
```

## Step 5 — STOP

**HARD RULE, again: stop here.** Do not email, DM, or otherwise contact the
prospect or anyone else; do not draft outreach unless Yousef explicitly asks
afterward. Approval and forwarding are Yousef's, by design. "Approve" from
Yousef green-lights *him* sending it — it is still not an instruction for
this skill to contact anyone.

## Caps and expiry

Every deployed demo enforces its own `demo.config.json` caps in the app
(template default: 20 turns / $5 model spend) and carries an `expiresAt`.
The router stops routing `demos.vendo.run/<id>` the moment the demo expires
or is killed, and the daily reap routine (below) tears down expired
deployments. If a prospect burns the caps mid-review, the demo shows a
"limit reached — book a call" card; redeploying resets nothing unless the
config changes.

## Troubleshooting

- **"needs Node >= 23.6 (native TypeScript type stripping)"** —
  `demo:create` / `demo:deploy` / `demo:capture -- demo-beats --host-config`
  load the template's TS schema directly; switch the session's Node to
  >= 23.6.
- **Captures run in the foreground only.** Never background
  `demo:capture -- demo-beats` (or hand it to a job manager that detaches
  it); let it hold the terminal until it exits, then read
  `capture.json`/the GIF.
- **`railway up` transient TLS error** — a one-off network flake; re-run
  the same `demo:deploy` command once (it is idempotent: re-renders the
  generated files, re-sets variables, redeploys). Only escalate if it fails
  twice.

## Installing on the mini

This file is the repo reference copy. To install: copy this directory to
`~/.claude/skills/demo-creator/` on the mini, sync the two secrets (the
flowlet `.env` and `~/.vendo/demo-router-admin-token`), make sure the mini's
Vendo checkout is registered with Orca and built (`pnpm install &&
pnpm build`), and create the reap routine below.

## Reap routine (daily teardown)

Expired or killed demos must actually come down (`railway down` + registry
row delete), not just stop routing. Schedule it once on the mini with the
`routines` wrapper (`bin/routine`), gtm line:

```bash
routine create --name gtm-demo-reap --schedule daily --time 09:00 \
  --role gtm \
  --precheck "test -f <vendo checkout>/bench/dist/demo-creator/cli.js" \
  --prompt "Vendo demo reaper. cd <vendo checkout on this machine>, then run: export ROUTER_ADMIN_TOKEN=\"\$(cat ~/.vendo/demo-router-admin-token)\" && pnpm --filter @vendoai/bench demo:reap -- --execute. It removes Railway deployments + registry rows for demos past expiresAt or killed (Railway cannot delete the empty service shells; that stays a manual dashboard step). Report via agent-notify to Yousef ONLY if something was reaped (ids + reasons, one plain-text message) or the command failed (include the error output). If it prints 'Nothing to reap', do not notify."
```

Replace `<vendo checkout>` with the mini's repo path at creation time. No
`--initiator`: the prompt carries its own notify-only-on-action reporting
rule. `demo:reap` without `--execute` is a dry run — useful for checking the
plan by hand. The token is the only secret it needs (no Anthropic key), plus
a logged-in `railway` CLI.
