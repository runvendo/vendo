# Pass 3 — the last three consumer-voice holes, in a real browser

Branch `redesign/ui-s1`, base `c0f4b98ac`. Conductor ruling 11 (`/tmp/final-integration-ruling.md`);
law: `docs/superpowers/specs/2026-08-02-agentic-ui-redesign-design.md` §16 law 3
(consumer voice), §15 (failure is conversation), §12 (honesty).

Captured by `packages/ui/e2e/pass3-consumer-voice.spec.ts` in real Chromium against
the shipped components, over the localhost wire fixture. Regenerate with:

```
pnpm --filter @vendoai/ui exec playwright test e2e/pass3-consumer-voice.spec.ts
```

## The captures

| file | what it shows |
| --- | --- |
| `a-approval-card-descriptor.png` | the approval card fed demo-bank's MODEL-authored descriptor. The card says **"This reads your data, as you."** — its own words. The descriptor is dropped whole, not truncated. |
| `b-waiting-queue-row.png` | the SAME ask's row in the waiting-on-you strip, arriving through the real `GET /approvals` door. Same title, same plain-words line: the card and its queue row cannot diverge. |
| `c-automations-failed-run.png` | a failed unattended run: **"This run didn't finish — nothing in your account was changed."** The scheduler's own refusal (a billing allowance and two console URLs) is nowhere on the row. |

## The machine audit, and its controls

Every capture's rendered text is audited with `packages/ui/src/consumer-voice.ts` —
the **one** vocabulary definition the product itself gates a descriptor sentence
with (`admissibleDescription` in `chrome/build-beat.tsx`) and the one the law's
vitest sweep uses. There is no second copy of those regexes.

**Positive control** (first test in the spec) — the audit is proven able to fail:

- `"…Amounts are integer cents (e.g. 285000 = $2,850.00): divide by 100…"` → `a model instruction: integer cents`
- `"POST /api/demo/pin"` (the route scanner's fallback, which Maple shipped on seven tools) → `an HTTP route line: POST /`
- and it passes the words the surfaces say instead ("This reads your data, as you.", "This run didn't finish — nothing in your account was changed.", "Reads the suggestions Maple offers you to try."), so it is a filter and not a blanket refusal.

**Honest limit, asserted rather than hidden:** the vocabulary does **not** flag the
scheduler's refusal (`meter-exhausted: blocked by allowance: … Upgrade your plan
(https://console.vendo.run/billing)`) — hyphens are not id underscores, and real
URLs are user content that gets lifted out. A filter could never have caught it.
That is precisely why ruling 11 answered capture (c) with a **product decision**
about what a failed unattended run may say to its owner, not with a regex. Its
control is the row's own text: the spec asserts the row contains neither
`meter-exhausted`, nor `allowance`, nor `console.vendo.run`.

**Negative control, run live.** The same spec was run with
`approval-card.tsx`, `waiting-queue.tsx` and `automations-panel.tsx` reverted to
`c0f4b98ac`. Three of four tests failed, and the browser's own text was:

```
(a) card:  "Needs your approvalGet spending insightsRead-onlySpending by category for the
            current period. Amounts are integer cents (e.g. 285000 = $2,850.00): divide by
            100 exactly once before displaying, including any totals you compute. Do not
            re-divide.Periodmonth…"
(b) row:   "Needs your approvalGet spending insightsSpending by category for the current
            period. Amounts are integer cents (e.g. 285000 = $2,850.00): divide by 100
            exactly once before displaying…"
(c) alert: did not say "This run didn't finish — nothing in your account was changed."
```

The positive-control test passed in both runs, as it must — it audits strings, not
components.

## Known, deliberately out of scope (visible in capture c)

Ruling 11 scoped pass 3 to the failed-run **copy**. The same row still renders
`{run.status}` as its raw slug ("error", and "pending-approval" for a parked run)
while `RUN_STATUS_LABEL` already maps those to "Failed" / "Waiting on approval"
two screens up, and `{run.startedAt}` as a raw ISO instant
("2026-07-11T12:00:00.000Z") while `formatAuditTime` is already imported in the
file. Both are one-token changes; both would force test edits unrelated to
failed-run copy (`panels.test.tsx` pins `getByText("stopped")`), so they are
reported rather than taken.

`StatusRibbon` is untouched per ruling 12: zero production callers, kept exported
and tested because a host may render it in a custom thread.
