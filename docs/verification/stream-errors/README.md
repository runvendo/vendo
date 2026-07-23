# Stream-error surfacing — visual verification (2026-07-22)

Rendered live (real browser, real `<VendoThread>` against a stubbed wire):

- `banner-vendo-detail.png` — a turn that died with a `VendoError`
  (`cloud-required`): the banner keeps the friendly headline and adds the
  safe, operator-crafted detail line with the error code.
- `banner-raw-hidden.png` — a turn that died with a raw transport error
  (containing a fake key): the banner stays generic; no internals printed.

Harness: esbuild bundle of `packages/ui/src` with an in-page fetch stub
emitting the ai-SDK error part shapes (`{"type":"error","errorText":...}`).
