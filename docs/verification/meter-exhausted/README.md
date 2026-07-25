# Meter-exhausted refusal surfacing — visual verification (2026-07-25)

Rendered live in a real browser through the REAL rail, no UI-code test doubles:

- `meter-banner.png` — demo-bank (Maple) at desktop viewport (1440×900),
  signed in as the seeded demo user, one chat turn sent. The stock
  `@ai-sdk/anthropic` provider was pointed (via `ANTHROPIC_BASE_URL`) at a
  local stub whose messages route answers HTTP 402 with the pricing-v3
  refusal body (`{ error: { code: "meter-exhausted", meter: "ai_tokens",
  used, limit, resets_at, exits } }`) — exactly what the Vendo Cloud gateway
  serves. The provider throws its APICallError, the agent's stream-error
  gate (`wireErrorMessage`) recognizes the refusal and crafts the sentence,
  the turn ends, and the thread banner renders the detail line with Retry:

  > Something went wrong and the response didn’t finish.
  > Vendo Cloud paused AI tokens — the allowance for this billing period is
  > used up (1,204,000 of 1,000,000 used; resets 2026-08-01). Upgrade your
  > plan (https://console.vendo.run/billing) or bring your own
  > infrastructure (https://docs.vendo.run/byo). (cloud-required)

Harness: `pnpm --filter demo-bank exec next dev` with
`ANTHROPIC_BASE_URL=http://127.0.0.1:4402/v1` and a 12-line node stub
returning the 402 body on every messages call.
