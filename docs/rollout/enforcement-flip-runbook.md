# Enforcement Flip — Operational Runbook

Turning metering from soft (log-only) to hard (blocking) per spec §5. Everything here assumes the emails in `migration-notices.md` and the ≥30-day notice window (§7 — applies even at introduction).

Enforcement surfaces (spec §5): gateway, sandbox, store, broker, automation scheduler — each checks `valid key + meter not exhausted` at service-call time, ~5% tolerance for metering lag.

---

## 1. Dark launch (log-only mode)

Run enforcement in **log-only mode for at least one full week** before any real blocking, ideally spanning a monthly reset boundary so both fresh and exhausted allowance states are observed.

Checklist:

- [ ] Log-only mode deployed to all five enforcement surfaces. A "would-block" decision is logged with: org ID, tier, meter, current usage vs allowance, service, timestamp. Nothing is actually blocked.
- [ ] **Would-block report** built and reviewed daily: for each day, every org that would have been blocked, grouped by meter and tier. This is the single artifact that decides whether the flip is safe.
- [ ] **Expected-vs-actual comparison:** the report's org list must match the known billing-triage pile of over-allowance orgs (see §6). Investigate every surprise in both directions —
  - an org in the report we didn't expect → metering bug or a genuinely over org we missed in triage;
  - a triage-pile org *not* in the report → enforcement isn't seeing them (this is exactly the 0.4.x failure mode: the 247K-over org was served — if it doesn't appear in would-block logs, the flip fixes nothing).
- [ ] Confirm the ~5% tolerance behaves: orgs hovering at 95–105% should flap into and out of would-block sensibly, not oscillate per-request.
- [ ] Confirm no *paying* org appears in the report for a hard-stop path it shouldn't hit (Pro/Teams only hard-stop with overage toggle off or at spend cap; Enterprise never hard-stops).
- [ ] Free reduced-lane logic (email-only signups) and idle-decay pause states show up correctly in the report, not as generic blocks.

Exit criteria for dark launch: 7+ consecutive days where the would-block report is fully explained — every entry expected, every expected entry present.

## 2. Notice timeline

| When | Action |
|---|---|
| **T-30** | Send migration emails (C to triage pile first, then A to all Free, B to paid if any). {{ENFORCEMENT_DATE}} in the emails = T-0. Dark launch should already be running or start now at the latest. |
| **T-30 → T-7** | Daily would-block report review. Warning emails at 80% of caps (spec §5) should already be live — verify they actually send. |
| **T-7** | Reminder email: short, links the original, restates the date and the two exits. Triage-pile orgs whose 60-day extension outlives T-0 are excluded from "you will be blocked" wording. |
| **T-1** | Freeze: no unrelated deploys to the five enforcement surfaces. Re-run expected-vs-actual one last time. Confirm rollback flag flip works in staging. |
| **T-0** | Flip day (§3). |

## 3. Flip day

Do the flip in the morning, on a weekday, with Yousef available.

1. [ ] Snapshot the final would-block report (this is the expected block list for the day).
2. [ ] Flip the enforcement feature flag from log-only to blocking. One flag, all five surfaces — no partial flips unless rolling back.
3. [ ] Watch for the first 2 hours, then hourly through the day:
   - **Block-rate dashboard:** actual blocks vs the T-0 snapshot. Actual should be a subset-or-equal of expected.
   - **Per-surface error rates:** gateway, sandbox, store, broker, scheduler — a block must surface as the developer-readable §5 error (reset date + upgrade/BYO exits), not as 500s or timeouts.
   - **Degrade asymmetry check:** blocked automation runs must appear as "blocked by spend cap/allowance" in console + owner email — loud, never silently unfired.
   - **Paying-org blocks:** must be zero except explicit toggle-off/spend-cap cases.
   - **Support/reply volume** on the notice emails and community channels.
4. [ ] **Rollback triggers — flip back to log-only immediately if any of:**
   - Any paying org is blocked outside its own toggle/spend-cap settings.
   - Any org in the 60-day-extension pile is blocked before its extended date.
   - >5% of monthly-active orgs blocked in the first day (expected figure from the dark-launch report is the baseline; the trigger is materially exceeding it).
   - Blocks surfacing as generic errors instead of the §5 error shape.
   - Any evidence of blocking on a *metering* failure (meter read errors treated as exhausted) rather than genuine exhaustion.
   Rollback is the same flag back to log-only. Blocking bugs get fixed in log-only mode, then re-flip. Rollback is cheap; do not debug live in blocking mode.

## 4. Post-flip verification

- [ ] **The 247K regression case, re-run live:** take the known far-over-allowance Free org profile (or a seeded test org pushed 200K+ tokens past the $5 credit) and confirm the gateway now refuses with the correct error naming the reset date and both exits. This is the defining regression for the whole project — it must be demonstrated, not assumed.
- [ ] One live probe per surface: exhausted-cap org gets blocked on gateway, sandbox, store, broker, and scheduler respectively.
- [ ] Pro org with toggle off: hard-stops at allowance with the enable-overage prompt showing rates.
- [ ] Pro org with toggle on: accrues past allowance, stops at spend cap.
- [ ] 80% warning email fires for an org crossing the threshold post-flip.
- [ ] Day 7 post-flip: compare week-one actual blocks to the dark-launch expectation; write up deltas.

## 5. Escalation path

1. **On-call for flip week:** whoever flipped the flag owns the dashboards.
2. Anything matching a rollback trigger → flip back first, tell Yousef second.
3. Anything ambiguous (weird block pattern, angry email from a real user, paying-org complaint) → Yousef directly (iMessage), before replying to the customer.
4. Yousef is the only one who sends customer-facing comms about incidents, per the DRAFT rule in `migration-notices.md`.

## 6. Pre-flip manual org checks (the billing-triage pile)

Before T-30 emails go out, manually review every org already known to be over allowance — the billing-triage pile from the 0.4.x cert campaign (headline case: the Free org ~247K tokens over the AI allowance that was still served).

For each org in the pile:

- [ ] Pull actual last-90-day usage per meter; confirm which new caps it exceeds.
- [ ] Classify: real user building something (→ email C, 60-day extension, flag for personal BYO help) vs abuse-shaped (farming/parking/churn patterns per `docs/pricing/free-abuse-sizing.md` — no extension; standard notice; candidate for signup-gate/reduced-lane demotion).
- [ ] Record its extension date if any; feed the exempt list to the enforcement flag config and the T-7 email exclusion list.
- [ ] Verify the org appears in the dark-launch would-block report (if it doesn't, enforcement can't see it — blocker for the flip).
- [ ] Idle orgs in the pile: let idle decay handle them (warn d14 → pause d21 → delete after 90 days paused) rather than enforcement drama.
