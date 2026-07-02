# ENG-204 Chat demo-readiness audit — findings

Date: 2026-07-01 · Branch: `yousefh409/eng-204-chat-readiness` · Screenshots: `docs/audit/eng-204/shots/`

## How this was audited

- `pnpm demo` (demo-bank, secrets via Infisical) in a real browser via Playwright, all three surfaces: full page (`/flowlet`), Cmd+K overlay, dashboard slot.
- **Live agent turns are impossible right now**: the Infisical `ANTHROPIC_API_KEY` has no credits (verified with a direct API call — `"Your credit balance is too low…"`). Everything that needs a model turn was exercised instead through `examples/shell`, which runs the same `@flowlet/shell` surfaces against `createStubAgent` (text turn → approval-gated tool → rendered UI node). States only reachable live are listed under **Gaps** — none were faked.

## P0 — demo blockers

| # | Finding | Evidence |
|---|---------|----------|
| P0-1 | **API key out of credits — no live turn can run at all.** Ops, not code: top up billing or swap the key in Infisical before anything else. | `02-page-turn-start.png` |
| P0-2 | **Raw provider error rendered verbatim in the chat, no retry.** All three surfaces show `Your credit balance is too low to access the Anthropic API…` in a red banner; the user's message dead-ends with no retry/regenerate affordance. Any live-audience failure (rate limit, network) will print raw API text on screen. `FlowletThread.tsx:102-106` renders `chat.error?.message` directly. Fix: friendly copy + a Retry action on the error banner. | `02`, `03`, `11` |
| P0-3 | **Approval card is a dev stub.** `approval required · renderDemoCard` in mono + raw `JSON.stringify` of the input (`ApprovalCard.tsx`). The demo's "put me on blast in Slack" beat runs through this card. Needs the friendly treatment: humanized action title, params as readable fields, brand styling. | `14-stub-approval-card.png` |
| P0-4 | **Approval resume duplicates the turn.** After approve *or* decline, the pre-approval assistant text and activity chip render twice, and the generated view card renders twice (`toThreadItems` has no dedup by node id / message replay guard). Reproduced on both page and slot surfaces with the stub; needs one live confirm once credits are back. | `15`, `16`, `17`, `21` |
| P0-5 | **Denied tool call presents as success.** After Decline, the activity header shows ✓ (only `output-error` flips it) and the expanded step spins forever — a denied state doesn't exist in `ActivityPanel`/`ActivityStep`. Deny must read as "Declined" and recover cleanly. | `17`, `18-stub-declined-chip-expanded.png` |

## P1 — polish

| # | Finding | Evidence |
|---|---------|----------|
| P1-1 | **Stale error banner survives "New chat".** Resetting the thread (`setMessages([])`) clears messages but not `chat.status`/`chat.error`, so the red banner sits above a fresh empty thread. | `08-page-new-chat-reset.png` |
| P1-2 | **Friendly tool labels cover almost nothing.** `tool-labels.ts` has exact labels for 2 host tools + Gmail/Slack regexes; every other tool falls back to crude humanization (`Renderdemocard`, and e.g. `GOOGLECALENDAR_EVENTS_LIST` → "Googlecalendar Events List"). ENG-204 scope requires friendly chips for every callable tool. | `17` |
| P1-3 | **"Vendo" hardcoded in the neutral shell package.** `FlowletSlot.tsx:31` defaults the greeting to "What can Vendo build here?" — brand leak into `@flowlet/shell`, visible to any host that doesn't pass a greeting. | `20-stub-slot-builder.png` |
| P1-4 | **Composio connection status not reflected.** Gmail/Slack show as unconnected in the Connect-tools picker despite ENG-178's verified connections. May be per-user connection store wiring; verify and fix before the demo (the integrations beat depends on it). | `07-page-connect-tools.png` |
| P1-5 | **Browser-default blue focus ring on suggestion chips** — off-brand inside the monochrome overlay. | `12-overlay-cmdk-open.png` |
| P1-6 | **Surface naming is inconsistent**: sidebar/page say "Vendo", overlay says "Ask Maple", page tab says "Chat". Product naming call — flagging for Yousef, not deciding. | `01`, `12` |

## P2 — nice-to-have

| # | Finding | Evidence |
|---|---------|----------|
| P2-1 | Multiple fresh page tabs all label themselves "New flowlet" — no disambiguation until a view is saved. | `17` |
| P2-2 | `examples/shell` copy says "click 'Ask Maple'" but the persistent launcher was removed (Cmd+K only), so the section looks broken to anyone running the example. | `13-stub-shell-overview.png` |
| P2-3 | Attachment chip thumbnail is tiny/cryptic; the "Only images and PDFs can be attached" validation note is unstyled small red text. Functionally fine (type/size/count limits all work). | `05`, `06` |

## What's healthy (verified)

- Empty-thread landing, suggestions, and composer are consistent across page / overlay / slot (`01`, `12`, `10`, `23`).
- Composer: multiline growth via Shift+Enter, Enter-to-send, disabled send when empty, paste/drag attachment support, type/size/count validation, stop button wired while streaming (`04`–`06`, code: `Composer.tsx`).
- Approve path renders the generated view and completes the turn; pin-to-card fills the slot end to end (`15`, `21`, `22`).
- Regenerate + copy turn actions work (`19`).
- Markdown pipeline is real: react-markdown + GFM + KaTeX, streamed fence balancing, safe-URL filtering, code copy button (`StreamingText.tsx`) — visual pass still needed live (see Gaps).
- Scroll behavior: stick-to-bottom, jump-to-latest pill, SR announcements (`MessageList.tsx`).
- Crash containment: `ThreadErrorBoundary` keeps the composer alive with friendly copy.

## Gaps — could not verify without live turns (do not assume OK)

1. Token-streaming feel, long-response behavior, layout shift during streaming.
2. `render_view` skeleton / "Building your view…" progressive reveal (code exists; never seen rendered).
3. Tool failure chip (✕ + error text) — code exists; never seen rendered.
4. Markdown variety on screen (tables, code, lists, links).
5. Network drop mid-stream (needs a live stream to sever) and interrupted-turn recovery via the stop button.
6. Composer busy state during a real in-flight turn.
7. Same-thread consistency across overlay/toast surfaces (needs real turns in demo-bank).

**Recommendation:** fix list above is implementable now (stub + tests cover P0-2…P0-5, P1-1…P1-3); the moment credits are restored, a ~30-minute live re-run covers the gap list and confirms P0-4 live.
