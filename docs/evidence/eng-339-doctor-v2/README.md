# ENG-339 Doctor v2 — live evidence

Captured against the Maple demo host (`apps/demo-bank`) booted with a real
`ANTHROPIC_API_KEY`, on 2026-07-16.

## Files

- `doctor-live-maple.txt` — `vendo doctor` text mode against the live Maple dev
  server. A real Anthropic turn answered ("All systems are go — Vendo's agent
  is online and ready to assist!") in ~2.7s; exit 0.
- `doctor-live-maple.json` — `vendo doctor --json` against the same server. One
  machine-readable object: `wired: true`, `exit: 0`, 17 `checks`,
  `liveTurn.ok: true` over `env-key` (real reply captured), `cloud.present:
  false` with the unlocks list, and `codex` drift `{ version: 0.144.4, tested:
  0.144, drifted: false }`.
- `doctor-live-unreachable.txt` — `vendo doctor` against a dead port. The live
  turn cannot run ("live model turn cannot run; start the dev server …"); exit 1.

## Live-turn design

Doctor's live turn POSTs one seeded health-check prompt to `{base}/threads` —
the same wired route the runtime serves — and streams the UI-message reply.
Exit 0 == a non-empty reply arrived. The rung shown is resolved from the same
wave-2 ladder the runtime uses, so doctor and runtime agree on what is wired.

Live-model tests are gated: the unit/integration suites use seams and a
scripted model (`corpus/hosts/express-host/e2e/doctor.e2e.test.ts` exercises the
real HTTP turn end-to-end), so CI without keys passes. The transcripts above
are the real-key verification run locally.

## Starter-allowance console contract (parked hand-off)

The vendo-side consumer is implemented (`vendo init` writes `.env.local` from a
minted key; the resolver already has the `vendo-cloud` rung). The console
endpoint is a Cloud console (vendo-web) follow-up:

```
POST /api/v1/keys
  auth:    user session (Bearer access token from `vendo cloud login`)
  request: { "purpose": "dev-mode" }
  response:
    { "key": "vnd_<40 hex>",
      "meter": { "runs": { "included": <n>, "remaining": <n> } } }
  errors:  404 / not-implemented  → init degrades to a pointer (no block)
```

The key is a metered dev-mode API key scoped to the caller's default org.
Separately, the `vendo-cloud` rung producing a working dev model needs a Cloud
model gateway (console-side); until it ships, `devModel()` reports the rung as
unavailable with instructions. Both are parked for the Cloud console project;
the vendo side is ready to consume them.
