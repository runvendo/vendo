# ENG-193 item 5 — browser verification notes (Task 16)

Run: 2026-07-04, `pnpm demo:accounting` (Cadence app, localhost:3000), judge off
(`FLOWLET_JUDGE_MODEL` unset), state reset via `POST /api/demo/reset` before the run.
Driven with Playwright against the Assistant page. The act-tier, verified fade fixture is
the host tool `sendClientMessage` (OpenAPI annotations; Composio `GMAIL_*` tools are
unverified in this app by design, so they can never fade).

## Beats verified

1. **Three same-shape approvals -> fade proposal.** Three separate "portal reminder"
   sends (Rivera, Chen, Delgado), each raising its own approval card, each approved.
   The third consent response carried `fadeEligible`; the `FadeProposalCard` rendered
   inline right after that turn's activity panel with the "third time you've okayed
   send client message" copy and both actions. — `01-fade-proposal.png`
2. **[Sounds good] -> 4th identical ask auto-executes.** `POST /api/flowlet/fade-proposal`
   returned 200; the 4th send (Harborview) executed with a "Sent client message" activity
   receipt and NO approval card. — `02-fade-active.png`
3. **Trust screen via the shield.** "Handled without asking" lists the minted grant
   (`Send client message · any input`, `since 1m ago`) with an "Ask me again" button;
   Automations empty; "Always needs you" lists the critical set (Set document status +
   create/update/delete automation); the diary line sits at the top of Activity; the
   activity feed shows the consent + grant_created events. — `03-trust-screen.png`
4. **[Ask me again] -> next ask prompts again.** The grant row disappeared immediately
   ("Nothing yet — everything still asks"), "Asked to check again on something" landed at
   the top of Activity, and the 5th send (Foster) raised a fresh approval card — revoke
   effective on the very next call. — `04-revoked-asks-again.png`
5. **Decline suppression.** Approving the 5th send re-offered the fade (correct: revoke
   doesn't suppress; the window still held 3+ yeses of the shape). Clicked **Keep asking**
   (decline, `POST /fade-proposal` 200), then a 6th send (Patel) was approved — NO
   re-proposal appeared (0 `.fl-fade` nodes in the DOM after the turn settled). —
   `05-declined-suppressed.png`

Derived shape note: `sendClientMessage`'s input (`id`, `body`) has no email-shaped or
type/kind/status/category string fields, so the derived shape is tool-wide and the minted
grant scope is `any input` — exactly the §7 "tool-wide only when the shape itself was
tool-wide" invariant, live.

## Findings (documented, not fixed — outside item-5 scope)

- **The diary counts read 0 in this demo** ("This week I handled 0 things — 0 reads,
  0 actions you approved..."), despite 6 live sends. Cause: the diary summarizes
  `tool_execution` audit rows, but Cadence's chat-path host tools are client-executed
  (`flowletExecutor: "client"`) and never pass through the server's `wrapTool`
  audit chain, so no `tool_execution` events exist for them. Item 5's Task 6
  deliberately wired only the automation-side gaps (`automation_firing` +
  parked-action `tool_execution`, plan deviation #5); auditing client-executed chat
  tools server-side is an architecture question for Yousef, not an item-5 fix. The
  diary sentence, layout, and the automation-driven counts all work as built.
- **Pre-existing lint failures on `demo-bank`** (react-hooks set-state-in-effect /
  refs-in-render across 5 files) fail the repo-root `pnpm lint`; this branch never
  touches `apps/demo-bank`. The `_prior` unused-var warning in the accounting app's
  `assistant/page.tsx` also predates this branch (commit bd5e2b77).
