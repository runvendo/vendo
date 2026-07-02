# ENG-204 fixes — before/after

Implements the Yousef-approved P0+P1 list (P2s deferred). Every fix verified in a real browser against live agent turns (credits restored mid-work); screenshots in `shots/`.

| Fix | Before | After | Change |
|-----|--------|-------|--------|
| P0-4 approval resume duplicated the turn | `33-live-after-approve.png` (every text + chip twice) | `52-after-approve-no-dup.png` | `originalMessages` passed to `toUIMessageStream` in the engine **and** the stub, so the resume continues the paused assistant message instead of appending a replayed copy. Regression: `approval-resume.test.tsx`. |
| P0-5 denied call read as ✓ + endless spinner | `17/18-stub-declined*.png`, `34-live-after-decline.png` | `53-after-decline-state.png` ("⊘ Declined", step: "Declined — didn't run") | `output-denied` is a terminal state in ActivityPanel/Step with its own muted ⊘ treatment; live header never echoes a denied step. Stub now scripts a real denial resume. |
| P0-2 raw provider errors, no retry | `02-page-turn-start.png` (verbatim Anthropic billing text) | banner/inline errors now friendly + Retry (`error-copy.ts`) | All error surfaces route through `friendlyError()`; raw detail on `title` attr only. Retry = `clearError()` + `regenerate()`. Tests: `error-copy.test.ts`, `thread-error-banner.test.tsx`. |
| P0-3 approval card was a dev stub | `32-live-approval-card-before.png` (tool slug + raw JSON) | `51-after-approval-card.png` | Redesigned: shield icon, "Needs your approval" eyebrow, imperative action title ("Create Gmail email draft"), params as labelled fields (empties hidden, long values truncated). **Awaiting Yousef's look before PR.** |
| P0-6 chips/cards crushed to 2px in long threads | `27-live-chip-success.png` (chip = hairline above the reply), `34` | `50/52` (chips fully visible in overflowing threads; `crushedPanels: 0` asserted in the driver) | `.fl-msglist > * { flex-shrink: 0; }` — children with `overflow:hidden` had a zero flex minimum. |
| P0-7 $-amounts parsed as inline math | `39/41-live-*.png` (garbled italic math between amounts) | `50-after-dollar-amounts.png` ("$285… $20… $3,420 versus $240" all literal) | `singleDollarTextMath: false` on remark-math; `$$…$$` display math still works. Tests: `streaming-text.test.tsx`. |
| P0-8 server died on empty-messages request | server crash log (`AI_InvalidPromptError` killed the process) | 400 + safe stream errors | chat-handler rejects empty `messages` with 400; engine `createUIMessageStream` gained `onError` so no execute failure can crash the process. |
| P1-1 stale error banner survived New chat | `08-page-new-chat-reset.png` | `55-after-newchat-clears.png` | Banner hidden on empty threads; demo-bank New chat now runs `stop() + clearError() + setMessages([])` — also the recovery path for a wedged stream. |
| P1-2 crude tool labels | "Renderdemocard" (`17`) | "Creating Gmail email draft", "Listing Google Calendar events", "Rendering demo card" | Generic toolkit+verb+object labeller for all Composio toolkits, camelCase-aware host-tool verbs, imperative form for approval titles. Tests: `tool-labels.test.ts`. |
| P1-3/P1-6 brand leak + naming inconsistency | "What can **Vendo** build here?" hardcoded in shell (`20`); Vendo/Ask Maple/Chat mix | shell ships zero brand strings; host passes `productName` | New `productName` seam on `FlowletShellProvider`; slot default greeting derives from it. Demo-bank passes "Maple" and renames its surfaces to "Ask Maple" (nav, agent prompt). |
| P1-5 default blue focus ring | `12-overlay-cmdk-open.png` | brand accent ring | `.fl-chip:focus-visible` uses `--flowlet-accent`. |
| P1-4 Composio status | — | — | **No change needed**: live-verified working as designed — toolkits start disconnected on purpose; one click fast-path connects (`28-live-integrations-connected.png`). |

## Live-verified gap list (was: 7 unverifiable gaps)

1. **Token streaming / long responses** — verified live, smooth, caret + throttle fine (`36/37`).
2. **View-generation skeleton** — verified: "Building your view…" + skeleton (`40`), rendered view (`41`).
3. **Markdown variety** — tables/code/links/headings verified (`26/27`); $-math bug found and fixed (P0-7).
4. **Tool chips in-flight/success** — verified live; failure state still only covered by unit tests (needs a real tool failure to see live).
5. **Interrupt/stop** — verified: partial turn retained, clean recovery (`38`).
6. **Network drop mid-stream** — partially addressed: instant transport errors now show the friendly banner + Retry; a *silently stalled* SSE (offline emulation keeps localhost sockets alive) still freezes with only Stop/New-chat as recovery (`54/55`). A stall watchdog is the real fix — proposed follow-up, not in this PR.
7. **Cross-surface thread consistency** — page/overlay/slot all render the same components; no divergence seen across the runs.

## Observations for Yousef (not fixed — product/model calls)

- After a decline, the model tends to misread the denial as "Gmail isn't connected" and renders a Connect card. UI now clearly shows ⊘ Declined; fixing the model's interpretation means a line in the engine instructions ("a denied approval is a user choice — don't request re-connect, acknowledge it"). Say the word and it's a one-liner in the agent prompt.
- The `request_connect` card auto-saves as a "Connect" tab on the page surface (saved tabs were meant for built views) — P2 territory.
- `apps/demo-bank/public/flowlet/components-sandbox.js` (generated bundle) produces ~238 pre-existing lint errors — it should be eslint-ignored; left untouched as out of scope.
