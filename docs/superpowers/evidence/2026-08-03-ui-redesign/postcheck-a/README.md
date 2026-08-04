# Post-check round A — honesty / voice / logic

Real Chromium (Playwright 1.61, deviceScaleFactor 2) against the SHIPPED
components in `packages/ui/e2e/harness`, **built in production mode** and served
by `vite preview` on port **3226** (killed after the run).

The production build matters: every fix in this round moves developer text
behind `developmentMode()`, and the harness's normal `vite dev` server replaces
`process.env.NODE_ENV` with `"development"` — so a dev-server screenshot would
show the developer half and prove nothing. These frames are what a customer sees.

    pnpm exec vite build   --config e2e/harness/vite.config.ts --outDir /tmp/vendo-harness-dist
    pnpm exec vite preview --config e2e/harness/vite.config.ts --outDir /tmp/vendo-harness-dist --port 3226
    cd packages/ui && node ../../docs/superpowers/evidence/2026-08-03-ui-redesign/postcheck-a/proof.mjs
    # 25 checks, all PASS — gates/browser-proof.log

## Frames

| file | what it proves |
| --- | --- |
| `a1-policy-banner-free-thread.png` | **C1** — thread + waiting strip + activity panel under the **unconfigured** guard posture, with no "Vendo is running without a policy · Configure `.vendo/policy.json`" anywhere. The banner used to auto-prepend itself inside every chrome boundary. |
| `a2-activity-humanized-row.png` | **C2** — "Invoices list — Amount cents $47.50 · Limit 10 · Status open". The row used to print the guard's `host_invoices_list {"amount_cents":4750,…}` verbatim. |
| `a3-two-money-approval-card.png` | **C5** — a fee beside the amount: no money sentence (the class line instead of the old, wrong "Sends $1.99 to Acme Utilities"), nothing folded behind Details, both amounts in plain sight, and no raw literal in a tooltip (**L37**). |
| `a4-thread-failure-no-retry.png` | **ruling 16** — a killed stream: the banner says what happened, zero Retry controls, and the turn's own Regenerate is the redo. |
| `a5-embed-line-plus-try-again.png` | **ruling 18** — a non-conversational surface (BYO embed, failed build): one honest line + Try again, and none of the wire's developer sentence. |
| `a6-voice-stage-consumer-line.png` | **M36** — the voice stage's failure reads "Voice session failed" with Retry, not the driver's raw `NotAllowedError`/provider text. |

Every frame is also machine-audited in the same run with the law's vocabulary
(`src/consumer-voice.ts`), over text nodes **plus `aria-label` plus `title`** —
the tooltip half is new (ruling 17a) and is what had been hiding L37.

## Gates (`gates/`)

| log | result |
| --- | --- |
| `build.log` | `pnpm build --force` — 24/24, 0 cached |
| `typecheck.log` | `pnpm typecheck --force` — 43/43, 0 cached |
| `ui-test.log` | `pnpm --filter @vendoai/ui test` — 98 files, **890 tests**, 0 failed |
| `lint.log` | `pnpm lint --force` — 6/6, 0 cached (forced per ruling 7) |
| `browser-proof.log` | the 25 browser checks above |

The root suite was deliberately not run here: sibling rounds were live in other
worktrees while this round ran, and a shared turbo cache makes a root run's
verdict theirs, not this branch's. The conductor's serial gate covers it.

## Two scenarios added to the harness

`/unconfigured-posture` (thread + waiting strip + activity under the
posture-forcing client) and `/approval-two-money` (a fee beside the amount).
Neither existed, which is part of why C1 and C5 were invisible to the browser
suite.
