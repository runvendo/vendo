# ENG-185 — Realtime voice mode: UX design

> **Status: DESIGN DECIDED — brainstormed live with Yousef 2026-07-02 (visual companion session).**
> The direction, surface behavior, feed layout, approval policy, and agent-brain decisions below are his calls; remaining smaller opens are flagged inline with recommendations. UI still pauses for Yousef's review before build and again before merge, per standing rules.
> Coordinated with the ENG-193 permissions proposals (sibling worktree) and the locked platform architecture (2026-07-01).

## 1. What's locked upstream

**PRD (2026-07-01):** straight-to-realtime bidirectional voice — the user talks, the agent talks back *and does/shows things live* mid-conversation. No dictation stepping stone. ENG-185 in Linear confirms: realtime session driving the same agent core/tools/permissions as chat; live rendering while speaking; barge-in; approval by voice or on-screen card via ENG-193; the existing `VoiceButton`/`useVoiceInput` stubs get **replaced, not extended**.

**OSS install model (locked 2026-07-02):** zero-infra BYO-keys. Voice is capability-additive — `+OPENAI_API_KEY` in `.env` turns it on. No separate relay server (see §7).

## 2. The decided experience: stage-native voice

**Voice is its own experience, not a chat accessory** (the "native voice" register — Siri/ChatGPT-voice, not a mic feeding a composer). Tapping the mic replaces conversation-as-text with the **stage**:

- **The stage fills the container you launched it from** — the page's content area becomes the stage; the Cmd+K overlay panel becomes the stage; a slot escalates to its design overlay (as slots already do for interaction) and *that* becomes the stage. Flowlet never floats voice UI over the host app's own chrome.
- **Anatomy:** the blob (voice presence) is **locked in place** at the top of the stage; generated views **stack into a scrolling feed** beneath it — newest arrives at the bottom with the `FluidReveal` morph, older views dim slightly, everything stays scrollable during the session. A transcript drawer peeks from the bottom edge (captions of the whole session so far); mute and end-session controls sit beside it.
- **The thread is still the record.** When the session ends, the transcript (both sides) and every generated view land in the launching surface's thread as ordinary history — pin-to-card, save-as-flowlet, and continuing in text all work on what voice built. Voice sessions are never amnesiac. A slot-launched session can end with "pin it" (spoken or tapped) committing the view to the card.

```
┌─ stage (fills the launching container) ───────┐
│                  ( ◕ ◕ )        ← blob, locked│
│                 ~ speaking ~                  │
│  ┌─ Overdue invoices ───────────────┐         │
│  │ Acme Co        $1,200    32 days │  ← older│
│  └──────────────────────────────────┘   (dim) │
│  ┌─ June vs May — collections ──────┐         │
│  │ June  $4,200 open · May  $1,700  │  ← new, │
│  └──────────────────────────────────┘  reveal │
│         (feed scrolls under the blob)         │
│  ⌃ transcript                    [🔇]  [✕]    │
└───────────────────────────────────────────────┘
```

### Session spine

```
enter ──► LISTENING ⇄ THINKING ⇄ SPEAKING ──► exit
              ▲            │
              └── barge-in ┘     (feed renders in parallel throughout)
```

- **Enter:** one mic tap starts an **open-mic session** (server VAD + semantic turn detection; not hold-to-talk). Mic-permission prompt happens here with a one-line explainer ("〈Agent〉 can hear you until you end the session").
- **The blob is one creature** — the ENG-205 `Thinking` metaball scaled up, with state expressed as behavior: *listening* breathes and ripples to the user's mic amplitude (driven locally, <100 ms — the "it hears me" signal); *thinking* is exactly today's Thinking cluster; *speaking* pulses to output amplitude, brighter, with a small glyph so listening/speaking don't rely on color alone; *muted* settles to a still disc with a slash. One tap on the blob = mute toggle. Needs two new fluidkit behaviors (amplitude-reactive listening, speaking pulse) — same upstream path as ENG-205's findings.
- **Voice narrates, the surface shows.** Views render in the feed; the voice gives the headline ("Three overdue, $4,200 total — Acme's is the oldest"), never reads tables. The voice-session system prompt (prompt catalog variant) encodes this: short spoken turns, name-the-view-then-summarize, offer "want me to read them out?" rather than defaulting to it. Spoken progress markers only when latency is felt ("checking your calendar…").
- **Exit:** tap ✕, `Escape`, a natural sign-off the model recognizes, or ~45 s silence → "still there?" → 15 s → soft-chime end. Ending voice never loses anything (the thread has it all).

## 3. Approvals on the stage — tiered (decided)

Adopts ENG-193's danger tiers unchanged; voice must not weaken them. **Read** runs silently. Then:

- **Act tier — spoken yes accepted, carefully.** The approval card slides into the feed (same `ApprovalCard`, listening ring) and the agent **repeats the key facts aloud** before accepting assent: *"I'll send the reminder to billing@acme.co — should I?"* Matching is conservative: clear assents only ("yes", "send it", "go ahead"); "hmm"/"sure?"/topic-change leave the card pending (agent re-asks or moves on), and the card stays tappable throughout — the hand can always settle what the ear muddled. On assent the card flips to **"Approved by voice ✓"** so audio and screen never disagree, and resolves the same `addToolApprovalResponse` path as a click.
- **Critical tier — voice announces, the hand confirms. Always.** *"This one I need you to confirm on screen — it's a $5,000 transfer."* The card renders with ENG-193's critical treatment (amber, consequence line, named button); a spoken yes is never accepted; `stepUp` host re-auth applies exactly as in text. The always-ask tier never becomes always-hear.
- **Standing grants stay a hand gesture** ("always allow …" is deliberately deliberate — no spoken grant creation in v1; the agent points at the card's menu instead).
- **Wiring is structural, not behavioral:** Topology B executes tools client-side through the same policy-wrapped executor as chat, so voice cannot bypass approvals even if the realtime model misbehaves. Voice approvals write the standard `AuditEvent` with `via: "voice"` — visible in ENG-193's Permission Center and ENG-194's future console.
- **Rejected:** spoken-yes-for-everything (a misheard word can move money — fails the bank-grade bar) and touch-for-everything (guts hands-free; acceptable only as a fallback milestone if assent-matching proves unreliable).

## 4. The brain: the realtime model is the agent (decided)

The realtime model gets the **same tool manifest and the same executor-side policy gates** as chat — parity on the things that must match is by construction, not by prompt discipline. Behavior is aligned via a voice variant in the prompt catalog (ENG-186). For **heavy UI codegen** (`render_view`), the voice agent delegates to the text model as a tool — conversation stays sub-second, codegen stays good; the demo path favors host-catalog components and saved flowlets (fast) over fresh codegen. The rejected alternative — realtime model as mouth-and-ears forwarding everything to the text engine — pays full text-agent latency as dead air mid-conversation, which is where voice UX dies.

## 5. Barge-in, latency, failure

- **Barge-in:** native (server VAD). Agent speech halts ≤~200 ms after the user starts talking; blob snaps speaking→listening; the cut-off caption is marked "— interrupted." **Barge-in stops speech, never work** — in-flight tool calls complete or hit their own gates; explicit "stop"/"cancel" additionally declines any pending approval.
- **Latency feel:** blob ripple is local (instant); live partial captions show the words were heard; slow tool work is narrated ("give me a second…"). Silence is the failure mode, not delay.
- **Network drop:** blob freezes to the desaturated disc, soft chime, "Voice dropped — reconnecting…" with auto-retry; after ~10 s: "Your conversation is saved — continue by typing, or tap to retry." The thread record makes this a soft landing. Mic-permission denied: one-line pointer to browser settings; the session never half-starts.

## 6. Accessibility & no-voice fallback

Voice is an enhancement layer (fluidkit doctrine): `useVoiceInput().supported` gates the button — no key configured, no mic, no secure context → button hidden, Flowlet is exactly today's product. Live captions on by default (the transcript drawer is the caption surface). `aria-live` announcements for state changes ("Listening", "Speaking", "Approval requested"). Keyboard: `Cmd/Ctrl+Shift+K` toggles a session (sibling of the overlay's Cmd+K), `Escape` ends, mute is tabbable. Reduced motion: static disc + text state labels. Eyes-free users: "read it out" always available, offered when a view's headline can't carry the content.

## 7. OSS wiring: no relay — the handler mints tokens (superseded §)

The earlier draft proposed a `@flowlet/voice-relay` package; the locked OSS install model does it better and this design adopts it:

- **`createFlowletHandler()` grows a voice ephemeral-token endpoint.** The host's existing backend route (`app/api/flowlet/[...path]`) mints short-lived OpenAI Realtime session credentials (`POST /v1/realtime/sessions` → `client_secret`) from the operator's own `OPENAI_API_KEY`, stamped with the voice system-prompt variant, the published manifest's tool definitions, VAD/voice settings, and bounded recent thread history (context carry-over when a session starts mid-thread). Audit events `voice_session_started/ended` write through the existing seam.
- **Audio never touches Flowlet or the host's backend** — browser ⇄ provider over WebRTC directly. Tool calls arrive on the client data channel and route through the existing client executor + policy + approvals (§3).
- **Capability-additive:** `ANTHROPIC_API_KEY` alone = chat + UI gen; `+OPENAI_API_KEY` = the mic button appears. Zero extra infra; Flowlet Cloud runs the identical endpoint hosted (BYOK later, mirroring ENG-198).
- **Provider posture:** OpenAI Realtime first (WebRTC + ephemeral tokens + function calling is the decisive browser fit); adapter boundary keeps Gemini Live (WebSocket-only) and a future Anthropic realtime API pluggable. Noted consciously: voice is the first Flowlet capability requiring a non-Anthropic key.
- **Operator cost guardrail:** realtime audio is order-of-magnitude dollars per conversation-hour; the handler ships a per-principal session-minutes cap **on by default**, config-overridable.

## 8. Session ↔ thread mechanics

- Starting voice from a surface binds the session to that surface's thread; bounded recent history (last N turns) is injected into the session config so mid-thread voice isn't amnesiac.
- Ending a session appends: transcribed user turns, agent speech (as assistant messages), generated views (as the same ui parts chat produces), approval cards in their resolved states.
- The `Channels` seam stays untouched (message-shaped); voice gets its own session-shaped contract (`VoiceSessions`: `createSession(principal, threadId) → transport config + ephemeral credential`) as `channels.ts` reserved. Contract detail is implementation-phase work.

## 9. Remaining opens (small, with recommendations — none block design review)

1. **Stage enter/exit transition** — the container's content morphing into the stage is a fluidkit "surface transition" (ENG-205 inc.3 territory). Recommend designing them together.
2. **Hold-to-talk fallback** for noisy rooms (long-press = manual turn)? Recommend: not in v1; add on real-world noise data.
3. **Voice persona:** one curated default provider voice, host-configurable id (like `productName`). No cloning.
4. **Mobile/touch specifics** (the stage is a natural full-screen sheet on mobile) — design pass when a mobile host exists.
5. **Feed density:** how many views before the feed becomes noise? Recommend soft-collapsing all but the last ~5 into a "earlier in this session" pill.
6. **"Read it out" verbosity contract** — how much the agent reads when asked; prompt-catalog tuning, not UI.
7. **Assent-matcher evaluation** — before build, a quick eval harness for the conservative yes-matching (false-accept rate is the metric that matters). If unreliable → ship touch-approvals first, add voice-assent behind a flag.

## 10. Explicitly not in this epic

- Concierge phone/SMS voice (ENG-191). Wake words / always-listening. Voice cloning. Voice UI floating over host chrome (rejected in brainstorm — stage fills Flowlet's containers). Tenant voice policy (ENG-194 — but `via: "voice"` audit events flow from day 1).

---

*Provider landscape sources: [OpenAI Realtime API — WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc), [OpenAI Realtime and audio](https://developers.openai.com/api/docs/guides/realtime), [Gemini Live API overview](https://ai.google.dev/gemini-api/docs/live-api), [Realtime voice API comparison (APIScout, 2026)](https://apiscout.dev/guides/realtime-voice-ai-apis-comparison-2026).*
