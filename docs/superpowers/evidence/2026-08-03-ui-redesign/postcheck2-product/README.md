# Post-check round 2 — the PRODUCT findings

Branch `redesign/postcheck2-product`, off `redesign/ui-s1` (`d53f6a4b1`).
Worktree `/Users/yousefh/orca/workspaces/flowlet/ui-s1-fixleaks`.
The sibling worker owns gate/test-infrastructure (`packages/ui/e2e/**`, the gate
scripts, `chrome-css.ts`); none of those are touched here.

**Ruling 21 is the rule of this round: a fix is not done until a test fails with
the fix reverted.** Every finding below records that proof — the test name and
what it printed when the source was stashed.

## Gates of record

| target | command | result |
| --- | --- | --- |
| build | `pnpm build --force` | 24/24, **0 cached** — `gates/build-force.log` |
| typecheck | `pnpm typecheck --force` | 43/43, **0 cached** — `gates/typecheck-force.log` |
| ui tests | `pnpm --filter @vendoai/ui test` | 102 files, **966 tests**, 0 failures — `gates/ui-test.log` |
| lint guards | `node scripts/dependency-guard.mjs && node scripts/portability-gate.mjs` | both green (the repo's `lint` script also runs `turbo run lint`, which no package defines a script for) |

The ROOT test suite was deliberately NOT run: the sibling worker is active in
another worktree and the two would interleave.

## Findings, worst first

| # | finding | file | reverting proof |
| --- | --- | --- | --- |
| 1 | CR-1 regression — the class came from the whole tool name | `chrome/build-beat.tsx`, `chrome/grant-set-card.tsx` | `consent-verb-class.test.ts` 6/11 fail |
| 2 | H-3 — focus lost on every way back that is not the grid's own tile | `chrome/center/apps-page.tsx` | `center.test.tsx` "H-3 …" — expected `<body>` to be `<h2 class="fl-center-title">` |
| 3 | H-4 — `inert` dropped by React 18 | `chrome/center/home.tsx` | `center.test.tsx` "does not rely on the JSX prop React 18 throws away" |
| 4 | H-2 — no inert ownership; toasts inerted | `chrome/inert-behind.ts`, `chrome/vendo-toasts.tsx` | `mobile-takeover.test.tsx` 2 cases |
| 5 | CR-2 — activity VALUES rendered verbatim | `chrome/activity-ledger.tsx` | law sweep + `activity-semantics.test.ts` 3 cases |
| 6 | CR-3 — the "Vendo: " prefix was the only gate | `chrome/thread/message-data.ts` | `error-surface.test.tsx` 6/13 fail |
| 7 | H-1 — card and row read different fields | `chrome/approval-card.tsx` | `consumer-voice-law.test.tsx` "one ladder" ×3 |
| 8 | H-7 — money counted at top level only | `chrome/build-beat.tsx`, `chrome/field-rows.ts` | `approval-degraded.test.tsx` ×2 |
| 9 | H-6 — the feed compared ids only | `hooks/approvals-feed.ts` | `approvals-feed.test.tsx` re-grade case |
| 10a | MEDIUM — ungraded reduced scrutiny | `chrome/thread/approval-wire.ts` | `approval-degraded.test.tsx` "UNGRADED never folds…" |
| 10b | MEDIUM — one skeleton for three tile states | `chrome/center/home.tsx` | `center.test.tsx` ×2 |
| 10c | MEDIUM — grounding part visible after a `{type,text}` round trip | `chrome/thread/message-data.ts`, `chrome/thread/composer.tsx` | `thread-grounding.test.tsx` 4/4 |
| 11 | M32 + M35 | `chrome/build-beat.tsx`, `chrome/vendo-toasts.tsx` | `tool-humanization.test.tsx` ×2, `affordances-eng225.test.tsx` ×2 |
| — | RULING 23 + the H9 coverage gap | `chrome/split-view.tsx`, `chrome/vendo-overlay.tsx`, `chrome/thread/parts.tsx` | `split-view.test.tsx` ×2 |
| — | M28 (fixed, with a stated limit) | `chrome/thread/parts.tsx` | `transcript-beats.test.tsx` "M28 …" |
| — | RULING 22 | — | confirmed already correct, no code change (see below) |

## CR-1 — the classification table

`cr1-classification-BEFORE.txt` and `cr1-classification-AFTER.txt` are the same
table printed against the same 19 tool ids, before and after. The five strings
the checker proved:

| tool | grade | BEFORE (row word / mandatory line) | AFTER |
| --- | --- | --- | --- |
| `host_getSharePrice` | read | Sends / "This sends a message, as you." | Reads / "This reads your data, as you." |
| `host_getOrder` | read | Moves money / "This moves money, as you." | Reads / "This reads your data, as you." |
| `host_getChargeDetails` | read | Moves money / "This moves money, as you." | Reads / "This reads your data, as you." |
| `host_listEmailTemplates` | read | Sends / "This sends a message, as you." | Reads / "This reads your data, as you." |
| `host_getSpendingInsights` | read | (none) / "This reads your data, as you." | Reads / "This reads your data, as you." |

Every READ-graded tool in demo-bank's real `.vendo/tools.json` is asserted
clean by the test, read from the catalog file itself rather than a copy.

Ruling 15 still holds in the other direction: `host_email_send` graded `read`
still reads "Sends" / "This sends a message, as you."

## Fixtures widened (ruling 21)

1. **the H6 "one ladder" fixture** had `descriptor.name === call.tool` at every
   tier. The descriptor is now `payments.transfer.v2` against a
   `host_transferMoney` call — which is what made H-1 visible.
2. **the wire's audit fixture** had no id in any VALUE. It now also serves the
   real `vendo_apps_edit` row (`{"appId":"app_9a3f2b1c","instruction":"add a
   chart"}`), exported as `appEditAudit()`.
3. **the consumer-voice law sweep** waited for "any text at all", which every
   wire-backed panel satisfies with its own HEADER before a row has loaded — it
   was auditing "Loading activity…". Wire-backed surfaces now name the content
   the sweep must see, and the `ActivityLedger` is swept directly (the panel
   only ever paints the wire's first page).

## Test edits, called out

**Defect-pinning (⚠️⚠️ — these tests REQUIRED the leak):**
`error-surface.test.tsx`, three assertions. They pinned that the operator's own
sentence reached the banner, and that `Vendo found no model key. Run \`vendo
login\` for a free dev key.` reached a user's transcript. Both are the CR-3
defect. They now pin the code's consumer copy and the absence of the wire's.

**Consequence-only (no assertion weakened):**
- `client.test.ts`, `hooks.test.tsx` — audit page LENGTHS, for the 4-row fixture.
- `split-view.test.tsx`, `transcript-beats.test.tsx` — `autoStage` takes a build
  key (ruling 23).

## Ruling 22 — confirmed, no change

`chrome/embeds.tsx:397` already renders `Try again` only when
`failed.retryable === true`; the honest line (`BUILD_FAILURE_COPY`) always
renders. `chrome/vendo-slot.tsx` offers Try again for a load failure, which is
retryable by nature (`useApp.refresh`). So the code already matches the ruling:
retryable → line + Try again; known non-retryable → line alone.

## Known limits stated in the code

- **M28** is FIXED but partially: staged progress is counted in NODES, so a
  stretch of a build that only fills props inside already-emitted nodes does not
  move the stage. Lifting it needs a content hash per render.
- **H-4**: the tile's `inert` is set through a ref callback, so it is not in the
  SSR string. Server markup is not interactive and the attribute lands before
  the first paint after hydration.
- **CR-1**: a tool whose LEADING token names no verb (`host_auth_create`,
  `host_demo_chips_list`, `vendo_apps_edit`) now falls to the risk-grade
  sentence rather than guessing a class. That is the point — it is the safe
  direction, and it is what stops an object voting on the verb.
