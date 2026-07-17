# ENG-216 — Tool & approval humanization (browser proofs)

Captured on the `@vendoai/ui` Playwright harness (headed Chromium) via
`packages/ui/e2e/screenshots.spec.ts`.

- `humanized-thread-host-metadata.png` — Maple-brand thread with a host
  `tools` metadata map supplied to `VendoProvider`. Shows: friendly chip labels
  + arg summaries ("Send email", "Look up client documents"), a run of eight
  identical read calls collapsed into one chip with an `×8` count, a custom
  arg summarizer ("$4,200 → Savings ••1234"), and a CRITICAL approval card with
  a friendly title + description, readable `Key: value` inputs, and **no**
  fabricated context byline.
- `fallback-no-metadata-dark.png` — the same surfaces with **no** host
  metadata (dark host theme): the tool chip and approval title fall back to the
  prettified id ("Email send"), args render as readable lines, and no raw slug
  or lifecycle string appears.
- `approval-card-real-ctx.png` — a standalone/queue `ApprovalCard` carrying a
  real server `ctx`: the `app · present · app_1` byline is shown (default
  `showContext`), proving only the in-thread fabricated ctx is suppressed.
