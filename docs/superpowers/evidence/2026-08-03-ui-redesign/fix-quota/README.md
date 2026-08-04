# fix-quota — two honesty defects, proven fixed (2026-08-03)

Branch `redesign/fix-quota-lie`, off `redesign/ui-s1` @ `c94ce0ac6`.

Both defects were found by the wave E2E, not by a test: a real demo-bank run
photographed what a person actually reads when an app build fails.

## DEFECT A — an ordinary failure was reported as "quota exhausted"

`packages/apps/src/runtime.ts` · `buildFailureReason`

The classifier tested one regex against every candidate string joined into a
blob, and that blob included the honesty gate's findings — which quote the
app's own content and the **whole host tool inventory** (`checking/facts.ts`:
"the host tools are: …"). demo-bank's inventory contains
`host_listScheduledPayments`; the pattern contained the bare word `payment`;
so an ordinary generation failure was persisted as
`{ reason: "quota exhausted", retryable: false }`.

Two lies in one sentence, and neither is recoverable by the reader: a **billing
claim about their account**, and — through every copy path that branches on
`retryable` — "try again later" for a build that fails identically every time.

Fixed at both layers, because either alone still leaves a lie reachable:

1. **Source.** Classification reads only what the PROVIDER said. Inside a
   terminal validation throw that is exactly the lines carrying the engine's
   `model generation failed: ` prefix (`generation/engine.ts` `askModel`) — the
   same source `MODEL_UNAVAILABLE_SIGNAL` is anchored against. The findings
   beside them are never read.
2. **Pattern.** `/\bquota\b|insufficient_quota|\bbilling\b|\b402\b/i`. The bare
   words `insufficient` and `payment` are gone. Word boundaries mean a tool or
   field NAME can never match: `host_getBilling` and `billing_id` have no
   boundary at the match edge. `insufficient_quota` is named explicitly because
   `_` is a word character, so `\bquota\b` would miss OpenAI's own code.

Deliberately NOT added, though it was proposed: `rate limit exceeded`. A 429
rate limit clears in seconds, so calling it a non-retryable quota exhaustion
only swaps this lie for a different one — it stays a retryable generic failure.
OpenAI's real quota refusal also arrives as a 429 but carries
`insufficient_quota`, which IS matched.

### The matrix

| Input | reason | retryable |
| --- | --- | --- |
| provider: "You exceeded your current quota, please check your plan and billing details." | `quota exhausted` | false |
| provider: "429 insufficient_quota" | `quota exhausted` | false |
| provider: "Provider returned 402 Payment Required" | `quota exhausted` | false |
| `statusCode: 402` / `VendoError("cloud-required")` | `quota exhausted` | false |
| findings: `names unknown tool "spending.data.reduce"; the host tools are: … host_listScheduledPayments …` | `generation failed` | **true** |
| findings: `binding "$payments.billing_id" …` + a "Payment History" label | `generation failed` | **true** |
| provider: "Request timed out after 60000ms" | `timed out` | true |
| `AbortError` | `timed out` | true |
| dev-model: `ANTHROPIC_API_KEY is set but @ai-sdk/anthropic is not installed…` | verbatim | false |
| dev-model: `Vendo found no model key…` | verbatim | false |
| dev-model: `your Anthropic API key was rejected (401)…` | verbatim | false |
| dev-model: `VENDO_API_KEY was rejected by the Vendo Cloud model gateway (401)…` | verbatim | false |
| provider: "Incorrect API key provided: sk-proj-123" (no raw leak) | `generation failed` | true |
| provider: "boom" / findings: "the model answered with no text at all" | `generation failed` | true |

Rows 5–6 are the defect. Rows 9–13 are pre-existing tests, untouched and
unweakened.

- `classifier-red.txt` — the defect reproducing on the pre-fix classifier
  (`git show <fix>^:runtime.ts` restored, one test red, the exact wrong values).
- `classifier-matrix.txt` — 20/20 green after the fix, every case named.

Unit-level is the whole proof here by design: a real provider quota exhaustion
cannot be induced without spending down a live account, and the input under
test is a string the provider hands us.

## DEFECT B — the BYO embed printed the developer's sentence

`packages/ui/src/chrome/embeds.tsx:367` (pre-fix)

The app embed rendered the wire's raw `reason` into `fl-card-byline` — on a
HOST's own page, inside whatever chat surface they built. Same defect, same law
(§16 law 3), same fix as the thread's banner (`91281801d`): the byline now says
`BUILD_FAILURE_COPY`, and the developer sentence keeps the home it already has
(the server's `[vendo] app build failed (app_…)` line, logged beside every
blocking finding). The embed's own "Try again" affordance is untouched.

Captured in real Chromium against the shipped component over the real wire
fixture — harness `packages/ui/e2e/harness`, new route `/byo-embed-failed`,
seeded with the **exact sentence the wave E2E photographed**.

| | File | What it shows |
| --- | --- | --- |
| BEFORE | `embed-failed-before.png`, `audit-before.txt` | the leak, painted: "the \`value\` expression is a declarative string that the DataTable does not evaluate, not JavaScript: amount / sum(spending.data.amount)" — audit VERDICT: **3 LEAKS** (backtick, call syntax, dotted path) |
| AFTER | `embed-failed-after.png`, `audit-after.txt` | "I couldn't finish building that view — nothing was changed. Ask again and I'll try a different approach." + Try again — audit VERDICT: **CLEAN** |

BEFORE was produced by reverting the one-line render back to `failed.reason` on
the running harness, so the two captures differ by exactly the fix. The audit
is mechanical over `innerText`: backtick, call syntax, dotted path,
snake_case identifier, package specifier, npm command, shouted env var.

The same audit is a permanent gate, not just a capture:
`e2e/byo-embeds.spec.ts` ("a failed build shows the consumer sentence") and
`test/embeds.test.tsx` (the four real leaked sentences, `it.each`).

## Called out

- **A test-only commit removes five assertions that PINNED defect B**
  (`955927cc5`). embeds.test.tsx demanded the raw reason on screen five times
  over — `getByText("quota exhausted")`, `getByText(/the build never
  finished/)` ×3, `getByText(/could not produce a valid app/)` — under the
  comment "The honest reason is shown". Each is replaced by an exact
  full-string match on the consumer copy, which is strictly stronger. Nothing
  about retryability, the button, the polling or the deadlines was touched.
- **A carry commit touches another worker's file** (`8aab38d5c`).
  `BUILD_FAILURE_COPY` does not exist on `redesign/ui-s1` — it was authored in
  `91281801d` on the unmerged `redesign/fix-build-defects`. The block added
  here is byte-identical to theirs (`git diff redesign/fix-build-defects --
  packages/ui/src/chrome/thread/message-data.ts` reports no difference in it),
  so the merge is a no-op and no duplicate constant can exist. Nothing else in
  that file was touched.
- **Cosmetic, not fixed:** the embed now reads "Spending board — couldn't
  finish" above "I couldn't finish building that view", visible in
  `embed-failed-after.png`. That doubling is inherited from the shipped pattern
  (the thread's banner and `vendo-slot.tsx` `SlotLoadFailed` both pair a
  headline with this copy) and is a copy-owner call, not this lane's.
- **Left in deliberately:** `failed.reason` is still carried in the embed's
  state and no longer rendered. It is the wire's own field and what a "show
  details" disclosure would read; deleting it would touch four more call sites
  in a file this change has no other business in.

## Gates

`pnpm build` 24/24 · `pnpm typecheck` 43/43 · `pnpm lint` (forced, 0 errors;
dependency-guard 15 packages OK, portability-gate all legs green) ·
`@vendoai/apps` 70 files / 742 tests · `@vendoai/ui` 95 files / 812 tests ·
`packages/ui` browser `byo-embeds.spec.ts` 3/3 Chromium.

No root `pnpm test` — three other workers were active on this repo.
