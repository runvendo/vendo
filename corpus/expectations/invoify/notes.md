# invoify labeling notes

Pinned SHA 93b21a22.

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
