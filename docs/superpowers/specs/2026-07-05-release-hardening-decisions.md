# Release Hardening — Decisions for Yousef

Everything from the hardening effort that needs your call, in one place.
Companion to the [bar](2026-07-05-release-hardening-bar.md) and
[inventory](2026-07-05-release-hardening-inventory.md).

## Blocking npm publish — RESOLVED by PR #60 (your parallel launch-prep session)

1. ~~fluidkit distribution~~ — **decided: bundled into shell's dist via tsup**
   (`noExternal`), fluidkit moved to devDependencies. The hygiene gate passes.
2. ~~License~~ — **decided: Apache-2.0** (LICENSE + NOTICE + per-package fields
   in #60).

**Reconciliation note:** #60 overlapped three wave-1 fixes (CLI bin guard,
NodeNext sweep, manifests). PR #56 was rebuilt as a stack ON TOP of #60 and
now carries only what #60 lacks: scheduler/fan-out isolation, pg.Pool error
listener, provider-peer degradation, server-side error hygiene, the two
release gates, and residuals the gates caught on top of launch prep
(sandbox-shims dist was still not Node-loadable; CLI's conflicting duplicate
typescript pins). Wave 3 (policy/approval integrity, twice Codex-reviewed)
is PR #64 stacked on #56. **Merge order: #60 → #56 → #64.**

## Judgment calls I made that you should ratify (all in PR #56)

- **Missing provider peer now degrades instead of failing fast.** Quickstart
  documented "fails fast with an actionable hint", but in practice that
  500ed *every* route (including /capabilities) on a documented one-key
  install. Now: chat gated off, hint in server log + chat 503, everything
  else healthy; a misconfigured `VENDO_MODEL` still fails loudly. Quickstart
  updated. Revert is one commit if you want fail-fast back.
- ~~sandbox-shims un-privated~~ — superseded by #60's approach (CLI ships
  shims inside its own dist with a workspace fallback); shims stays private.
- **A failed one-shot automation firing is consumed, not retried** — matches
  the existing "missed fires are skipped" rule; the occurrence, not the
  delivery, is what happens exactly once.

## UI decision queue

Bug bash complete (both demo apps, browser-driven). Screenshots:
`~/Desktop/vendo-ui-bash-2026-07-05/` (cadence/ + demo-bank/, numbered in
visit order). Verdicts: Cadence reads convincingly native (until 480px);
Maple is visually strong but trust-breaking in prose and numbers.

### Needs your design call (screenshot-backed, from the bash)

- **480px is broken on both apps** — Cadence: host sidebar never collapses,
  composer clipped off-screen (`cadence/11`); Maple: header actions +
  saved-vendo tabs overflow, composer placeholder overlaps itself
  (`demo-bank/12`). Needs a responsive strategy decision for the shell.
- **Consent card exposes raw tool params** — "Is html: false", "User id: me",
  plus an "Unverified tool" badge on a stock Composio Gmail tool
  (`cadence/06`). What should an end-user consent surface actually show?
- **"Connection lost" alert UX** on stream failure (`demo-bank/04`) — raw
  alert today; needs the intended recovery surface.
- **demo-bank has no Trust (🛡) tab while Cadence does** — config or gap?

### Code-fixable from the bash (queued into fix waves, no design decision)

- **Generated-number correctness (HIGH):** Maple total tile "$40.18" vs its
  own table's $4,017.81 (100× cents bug, `demo-bank/05`); Cadence deadlines
  all +1 day vs host (timezone parse, `cadence/04`). Both are the known
  "$-math / format-hints" class — needs data-format hints in view prompts.
- **Host-identity leak (HIGH):** Maple's agent calls the host "Cove" in
  refusal prose (`demo-bank/06`) — "Cove" exists nowhere in the repo; the
  prompt core must ground the host name harder.
- **Stream reliability (HIGH):** ERR_INCOMPLETE_CHUNKED_ENCODING on /chat,
  then reload wiped the whole thread (`demo-bank/08`) — persistence should
  have restored it.
- **Deliveries 404 loop:** VendoToasts polls /deliveries every 2s forever on
  hosts with automations off — should gate on capabilities.
- **Approval decline ignored (MEDIUM):** clicking "No" re-pitches the same
  action (`cadence/07`) — decline isn't reaching the model as intent.
- **Trust panel miscounts (MEDIUM):** "4 actions you approved" after zero
  approvals, reads counted as actions (`cadence/08`).
- Copy/template glitches: "So I can To send…" concat (`demo-bank/07`);
  stray "0" text node in page + sandbox; chart legend shows raw "amount";
  OpenUI drops the brand `*ChartPalette` keys (10× console warning, both
  apps — generated charts likely lose brand colors).

### Queued earlier from the code audit (unchanged)

- Raw tool `errorText` rendered verbatim in the DOM (shell ActivityStep +
  ToolCall, react host-tool path, stage bridge) — needs your call on the
  friendly-error copy/design.
- `installVendoHost` collision/eval errors yield a permanently blank sandbox
  (needs an error surface design).
- Voice: Cmd+Shift+K also toggles the overlay closed mid-session; failed
  voice startup leaves the mic live after the error; transcript drawer has a
  hardcoded "Maple" brand string.
- OpenUI console spam: 10× "barChartPalette … will be ignored" warnings on
  every boot (either drop the key or upstream a palette API to OpenUI).
- Capabilities-fetch failure leaves the chat UI optimistically enabled
  forever (vendo-next client treats null capabilities as enabled).

## Not decisions, but waiting on you

- Your bug/UI notes (you mentioned having some) — they merge into the
  inventory triage.
- Release-bar edits (PR #58) — flows 1–9 are what everything is judged
  against; veto/add now if it's wrong.
