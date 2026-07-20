# execution-v2 Wave 4 — layer 3 (served apps) live browser gate

Live verification of Wave 4 on **Maple/demo-bank in a real browser** (real
Auth.js login) against **real e2b + real Claude**, with a cloudflared tunnel
for the box's `/box` callbacks. Box template built from
`packages/apps/box/build-template.mjs` (this run: `7hs83rr52mi0fdaromdl`,
rebuilt so the baked agent-loop carries the Wave-4 `servesUi` report field).

## Flag ON (`VENDO_EXPERIMENTAL_SERVED_APPS=1` → `createVendo({ apps: { experimentalServedApps: true } })`)

Prompt: **"Make me a full kanban board for my invoices with drag-and-drop
between columns"**, then the 2→3 escalation edit ("Rebuild this as a full web
app…") on the resulting app.

- `browser/w4-01-apps-workspace-flag-on.png` — the Apps workspace before.
- `browser/w4-02-kanban-creating.png` — create in flight.
- `browser/w4-03-kanban-embedded.png` — the layer-1/2 app the create produced
  (tree + islands; the box seeded durable invoice rows through the tunnel).
- `browser/w4-04-editing-tree-keeps-serving.png` — the 2→3 box build running
  (button: "Editing…") while the OLD surface keeps serving. The flip happens
  only after the box's own checks and the host's `GET /` verification pass.
- `browser/w4-05-served-kanban-embedded.png` — after the flip: the document is
  `ui: "http"` (tree gone, rung 3) and the surface is the box's REAL web app,
  served from the machine's public ingress
  (`https://8080-<sandbox>.e2b.app/?vendoTheme=<Maple theme tokens>`), embedded
  in a sandboxed iframe (`allow-scripts allow-forms allow-same-origin`).
- `browser/w4-06-drag-card-moved.png` — INTERACTIVE in the real browser:
  "Test Invoice" dragged Draft → Sent (counts 2/3).
- `browser/w4-07-reload-persisted.png` — full page reload + fresh `open()`:
  the moved card is still in Sent — the drag round-tripped to the box server
  (durable rows), and the reopen is a wake-on-open over the snapshot.

## Flag OFF (default)

- `browser/w4-08-flag-off-create-refusal.png` — the same kanban prompt refuses
  cleanly with the typed `VendoError("not-implemented")` naming the flag.
- `browser/w4-09-flag-off-open-refusal.png` — `open()` on the already-served
  app refuses with the same error (wire: 501, code `not-implemented`); the
  de-graduation guard blocks the flip path the same way.

## Honest notes

- **e2b TTL finding (from PR #418) reproduced and mitigated**: the first 2→3
  box build died when the machine hit the default 300s provider TTL mid-edit
  (edit timed out at 900s, clean rollback — the tree kept serving, proven in
  `w4-04`). Fix in this PR: `VENDO_E2B_TIMEOUT_MS` operator knob on the
  umbrella's e2b selection; the gate ran with 30 min and the build finished in
  ~4.5 min. Extending the TTL on activity inside the adapter remains the
  root-cause follow-up.
- The first create produced a tree+islands kanban (a strong layer-1 artifact);
  the explicit 2→3 escalation edit is what produced the served app. Both paths
  are the designed behavior: create lands a working tree first, the box build
  swaps the surface only when its checks pass.
- demo-bank now declares `e2b` as its own dependency: the optional-peer SDK
  must be installed by the HOST for the umbrella's BYO e2b path to resolve at
  runtime under Next bundling (`ERR_MODULE_NOT_FOUND` otherwise).

Cleanup: the app was deleted in-client (machine + snapshot reaped via
`destroyResources`) and the account swept — zero live sandboxes after the run.

Wave-3's owed browser evidence (invoice-chaser digest board) is delivered by
PR #418 (`docs/verification/exec-v2-wave3/browser/`), not duplicated here.
