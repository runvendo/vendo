# donut-render-resilience — a storage fault costs the save, not the view

## The defect

On the deployed Maple, "Show my spending by category" generated cleanly —
`gen pipeline full attempt=0 valid=true`, no server error, no watchdog, no
smoke-render failure — and the user still got nothing usable:

- a half-painted donut and two more cards frozen on "Building your view…"
  (verified on the DOM attribute `data-state="building"`, not the label text —
  both labels stay mounted for the crossfade, so the text alone proves
  nothing),
- one of them reading "No spending data",
- the agent finishing with "I'm running into a temporary issue creating the
  app view" plus a plain text table,
- and none of the three apps in the store afterwards.

## Root cause

`runtime.create` sequenced the final `emit(finalTree)` **after**
`apps.put`. The Cloud console was rejecting every `vendo_apps` write, so the
put threw and took the emit with it:

- each card kept the last mid-stream payload it had received — forever. The
  donut that looked "rendered" was a frozen streaming paint; the "No spending
  data" card was a frozen partial emitted before its query resolved. Neither
  is a render bug: both are the *absence* of the settling emit.
- `createAgentTools` caught the throw and answered `status: "error"`, so the
  agent apologized and rebuilt the app twice more — three cards for one
  prompt.
- nothing was logged on the user path, which is why the server looked healthy.

The store failure itself is a Cloud console defect, out of this repo's reach:
its `vendo_apps` table is missing the `revision` column the store engine's
write path requires (OSS added it in Wave 7, #427 `schema.ts:167`;
`ensureSchema()` is explicit and the console's database never ran it). Every
write answers `503 {"code":"unavailable","detail":"column \"revision\" of
relation \"vendo_apps\" does not exist"}`. Reads are unaffected, which is why
the demo looks alive until you ask it to build something.

## The fix

A storage fault now costs the user the SAVE, never the VIEW.

1. The finished view is emitted **before** anything that can fail. The
   document is generated, validated and data-resolved by that point.
2. A failed persist is caught, degrades the app to view-only, and is reported:
   `[vendo] app not saved (<id>): the view rendered but the store rejected it
   — <reason>` plus `(NOT SAVED)` on the completion line. Escalation is
   skipped (every rung writes through the same store).
3. The create tool answers `ok` with an `unsaved` note instead of an error, so
   the agent states the one true thing and does not rebuild. The note's
   guidance says so explicitly.
4. Separately: a query that resolves non-ok contributed no data and said
   nothing, so an empty card was indistinguishable from a frozen one. Each
   distinct unresolved query now warns once. Render behavior unchanged.

## Proof

Maple run against the **live Cloud store** — the same store still rejecting
every app write — with this branch's build. Real browser, prompt typed
verbatim.

Operator log:

```
[vendo] gen pipeline full attempt=0 valid=true ms=7198
[vendo] app not saved (app_615f58df-…): the view rendered but the store rejected it — Store request failed.
[vendo] gen create complete app=app_615f58df-… total=45.5s (NOT SAVED)
```

Browser (DOM-asserted, not eyeballed):

| | before | after |
| --- | --- | --- |
| cards | 3 | **1** |
| card state | `building` ×3 | **`ready`** |
| donut drawn | frozen partial | **8 svg paths, Total $5,058.38** |
| apology text present | yes | **no** |

The assistant's closing line: *"Housing is the dominant line item… The view
could not be saved to your apps list, but it's rendered above."*

Screenshot rides the PR (`docs/verification/README.md`: media is not
committed).

## Cents seam — checked, clean

Traced every hop for the donut slices: the route returns integer cents
(`505838` total), the catalog declares cents, `MapleSpendingDonut` passes them
through unscaled (`Math.round` only), and `formatUSD` divides by 100 exactly
once. Rendered `$5,058.38` = 505838/100. The dollars in the old fallback table
were the correct presentation of cents, not a unit bug.

## Still open, not this branch

- The console's missing `revision` column — every Cloud-backed deployment
  cannot persist apps until that migration runs (vendo-web + production
  database; needs Yousef's sign-off).
- The console's store also 503s on writes ≥64KB ("Connection terminated
  unexpectedly"; ≤48KB fine, 6/6 deterministic) — independent of the column,
  and it will bite apps carrying island source once the column lands.
- Cadence additionally has an exhausted `ai_tokens` meter (10.5 of 10, resets
  2026-08-21), so its generation refuses outright.
