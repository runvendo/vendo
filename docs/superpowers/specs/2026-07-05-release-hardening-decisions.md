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
typescript pins). **Merge order: #60 → #56.**

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

Populated by the browser bug bash (running) — will be appended here with
screenshots. Already queued from the code audit (all confirmed, all
UI-affecting, none built without you):

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
