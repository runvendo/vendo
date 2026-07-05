# Release Hardening — Decisions for Yousef

Everything from the hardening effort that needs your call, in one place.
Companion to the [bar](2026-07-05-release-hardening-bar.md) and
[inventory](2026-07-05-release-hardening-inventory.md).

## Blocking npm publish (decide before ENG-198)

1. **fluidkit distribution.** `@vendoai/shell` ships
   `fluidkit: file:../../vendor/fluidkit-0.5.0-…tgz` — consumer installs abort.
   Options: (a) **publish fluidkit to npm** from runvendo/fluidkit
   (recommended: honest dep graph, hosts can dedupe/upgrade), (b) bundle it
   into shell's dist, (c) ship the tgz inside the package. Tracked as KNOWN
   in `scripts/check-publish-hygiene.mjs` — the gate goes red for it the
   moment you pick (a) and we swap the dep to a version range.
2. **License.** Repo has no LICENSE and no `license` fields — legally
   unlicensed. Pick MIT / Apache-2.0 / other; the sweep after is mechanical
   (root LICENSE + per-package field + the hygiene gate starts enforcing it).

## Judgment calls I made that you should ratify (all in PR #56)

- **Missing provider peer now degrades instead of failing fast.** Quickstart
  documented "fails fast with an actionable hint", but in practice that
  500ed *every* route (including /capabilities) on a documented one-key
  install. Now: chat gated off, hint in server log + chat 503, everything
  else healthy; a misconfigured `VENDO_MODEL` still fails loudly. Quickstart
  updated. Revert is one commit if you want fail-fast back.
- **`@vendoai/sandbox-shims` is now publishable** (was `private: true`) — the
  published CLI resolves its dist at runtime, so it must ship. Alternative
  (bundling shim sources into the CLI package) rejected as a bigger change.
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
