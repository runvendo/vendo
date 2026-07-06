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
is PR #64 stacked on #56. Wave 4 (client/state reliability) is PR #66 and
wave 5 (generated-view data correctness) is PR #65 — siblings stacked on #64,
no file overlap, either merges first. **Merge order: #60 → #56 → #64 → #65+#66.**
The shell-UI wave (your four approved designs) is building now and will follow
as its own PR with screenshots.

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

## UI decisions MADE (2026-07-05, in session)

- **Mobile:** full-screen overlay takeover below ~768px (Intercom pattern) — approved.
- **Consent card:** human summary only; raw params never shown to end users — approved.
- **Glass skeletons:** the landing page's glass+shimmer recipe, tinted from each
  host's theme.json accent, for render_view placeholder / saved-vendo refresh /
  library+tray loading (FluidThinking stays for chat thinking) — approved
  enthusiastically; exploration mock at
  `~/Desktop/vendo-ui-bash-2026-07-05/glass-skeleton-exploration.html`.
- **MCP approvals:** route through the consent/audit/grant channel — approved, build next.

All four land as one shell-UI wave PR with browser screenshots for review before merge.

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

## Shell-UI wave — built (your 4 approvals), one flag remaining

Built on branch `yousefh409/shell-ui-wave` (5 commits): glass skeletons
(theme-tinted, render_view placeholder + refresh veil + library/tray),
<768px full-screen takeover, summary-only consent card, MCP approvals through
the consent channel. Your amendment applied: **critical-tier cards keep their
material fields, humanized** (amount/recipient with proper labels, no raw
param dump); ordinary cards stay summary-only.

**One flag left for you:** critical cards render numbers as-is ("Amount: 1200"),
NOT as currency ("$500.00") — the card has no schema knowledge of which numbers
are money/what currency, and there's a standing rule against doing money math on
model-authored values. Wave 5 just built a per-field format-hints system (cents/
etc.) — wiring that into the card would give real currency rendering. Want that
as a follow-up, or is "Amount: 1200" fine for v1? (Not blocking the PR.)

Two smaller notes: demo-accounting's `/assistant` hand-rolls its own page div so
it doesn't get the mobile takeover (shell elements do — wiring it is a 1-liner if
you want it); MCP "yes" writes the consent/audit row but mints no reusable grant
(descriptor can't enumerate MCP tools server-side — repeats re-ask).

## Final browser pass — outcomes (integration build)

Consolidated pass ran all shell-UI + data-correctness checks. PASS: glass
skeleton (render_view placeholder, Cadence-green), mobile takeover (full-screen
<768px, composer visible), ordinary summary-only consent card (no params, no
badge on catalog tools), decline semantics (acknowledges, no re-pitch, re-asks
on new intent). Two items needed follow-up and were chased down:

- **Donut center 100× ($40.18)** — the prompt "convert-once" rule didn't hold
  (model re-divided the centerValue). FIXED DETERMINISTICALLY: the Donut now
  derives its center money-total from the sum of the legend values
  (`resolveCenterValue`), so it structurally can't disagree; non-currency
  centers pass through. Shipped in PR #65. NOTE: the first re-check ran on a
  turbo-CACHED bundle that lacked the fix (still showed $40.18); a clean
  rebuild deploys it and a fresh browser check is confirming. The fix relies
  on slices carrying currency `display` strings — if the check shows the
  model omits them, a value-based fallback gets added.
  **RESOLVED & VERIFIED (2026-07-06):** live check showed the model was
  emitting raw cents in slice.value with NO display strings, so the
  legend-derived center had nothing to work from. Fixed by strengthening the
  descriptor (value is the final display amount, never raw cents; give each
  money slice a formatted display; center is derived — omit centerValue for
  sums). Two independent fresh runs now render $4,017.81 with a full legend.
  Shipped in PR #65. A hard guarantee (display *required*) would break saved
  donuts lacking it — left as your call; the prompt+derivation combo is
  verified working in practice.
- **Chart brand palettes don't apply (both apps) — RESOLVED to a scoped
  follow-up, needs your call.** Root-caused in OpenUI internals: the
  `*ChartPalette` keys are valid Theme *type* keys but aren't in OpenUI
  0.12.1's runtime `defaultLightTheme`, so its ThemeProvider IGNORES them
  (the warning is literal) and charts read a zustand store, not the React
  ThemeContext our bridge re-provides. So brand chart palettes NEVER reached
  charts in these demos — before or after wave 4. Cadence bars render
  fallback brown, not brand green. Wave 4's change still earns its keep: it
  removed the invalid keys and silenced 10 false-positive console warnings
  (no palette applied either way → no regression). **Real brand-chart theming
  = a follow-up:** find OpenUI's actual palette path or bump OpenUI. Cosmetic
  on demo test-beds; not blocking. **Want it as a follow-up wave, or accept
  OpenUI-default chart colors for launch?**

- **Critical consent card:** couldn't be exercised live — NEITHER demo exposes
  a critical-tier (irreversible/money) tool, so demo-bank's agent refuses
  transfers ("Maple's API doesn't expose a transfer tool"). The humanized
  material-fields behavior is covered by jsdom unit tests; a live screenshot
  needs a host with a genuinely critical tool (demo gap, not a code gap).

## New flags from wave 4 (client/state fixes)

- **Cadence has no thread persistence at all** — its hand-rolled routes never
  persist or serve threads, so the new reload-restore seam has nothing to
  restore there. Wire Cadence to the durable thread store, or accept for the
  demo?
- **Composio-executed reads count as "actions you approved"** in the trust
  diary on every host — Composio tools carry no annotations by design, so
  reads can't be bucketed as reads. Needs an annotation source (toolkit
  metadata? allowlist?) or a decision-aware audit field.

## Not decisions, but waiting on you

- Your bug/UI notes (you mentioned having some) — they merge into the
  inventory triage.
- Release-bar edits (PR #58) — flows 1–9 are what everything is judged
  against; veto/add now if it's wrong.
