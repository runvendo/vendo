# invoify labeling notes

Pinned SHA 93b21a22.

## Curated `ai-expected.json` risk rows (hand-verified, FROZEN)

Both rows below were mechanically derived from the HTTP verb (POST → `write`)
and are corrected to `read` because the handler mutates nothing. Each grade was
read from the pinned source and independently confirmed by a second reviewer
given only the handler excerpt. Do not relabel these from model output.

- `POST /api/invoice/export` → `read`. The route is a one-line delegation
  (`app/api/invoice/export/route.ts:7`); the service only serializes the
  request body. `services/invoice/server/exportInvoiceService.ts:31`:
  `const jsonData = JSON.stringify(body);` — the JSON/CSV/XML branches all
  return a serialized response. The file imports no database or storage client.
- `POST /api/invoice/generate` → `read`. Renders the invoice template and
  returns PDF bytes. `services/invoice/server/generatePdfService.ts:65`:
  `const pdf: Uint8Array = await page.pdf({` — the headless browser is
  ephemeral and closed in `finally` (lines 91-107); nothing is persisted.

## Known expected-miss: `background` (#f1f5f9)

The token sheet declares `--background: 0 0% 100%` (#ffffff,
`app/globals.css:7`), but the app paints its real page background with a
utility on a nested locale layout: `app/[locale]/layout.tsx:90` applies
`bg-slate-100` (#f1f5f9) to the body. The label records the rendered
truth per the labeling law; the deterministic exact read is faithful to
the declared token, so a nightly miss on this dimension is expected —
not an extraction regression. Overriding exact token reads with a
nested-layout utility scan would break the exact-read precedence law on
one repo's evidence (analysis: extraction-quality-1 lane, 2026-07-26;
prior documentation: PR #450's pre-documented background expected-miss).
