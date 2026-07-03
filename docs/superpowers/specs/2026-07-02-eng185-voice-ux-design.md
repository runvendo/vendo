# ENG-185 — Realtime voice mode: UX design proposals

> **Status: PHASE 1 — proposals for Yousef's brainstorm. Nothing here is decided; nothing gets built until he directs.**
> Companion to the locked platform architecture (2026-07-01) and coordinated with the ENG-193 permissions proposals (2026-07-02, sibling worktree). All UI here pauses for Yousef before build and again before merge.

## 1. What's locked, what exists

**Locked by the PRD (2026-07-01):** straight-to-realtime bidirectional voice — the user talks, the agent talks back *and does/shows things live* mid-conversation. No dictation stepping stone, no push-to-talk-into-the-composer. ENG-185's old push-to-talk scope is obsolete.

**Raw material already in the codebase:**

| Piece | Where | What it gives us |
|---|---|---|
| Voice seam stub | `flowlet-shell/src/use-voice-input.ts` + `VoiceButton.tsx` | `useVoiceInput()` returns `supported: false`; the mic button already sits in the composer, hidden until a real pipeline lands. The seam anticipated this epic. |
| Three surfaces, one thread | `elements/FlowletPage · FlowletOverlay · FlowletSlot` | All three render the same `FlowletThread` (message list + composer). Anything added to the thread reaches every surface for free. |
| Fluid vocabulary (ENG-205) | `FluidThinking`, `FluidReveal`, `FluidRipple`, ConnectTray, fluidkit tarball | An organic metaball *Thinking* blob is already the agent's liveness identity; skeleton→view morphs; enhancement-layer pattern (lazy load, static-first, reduced-motion = static). Voice liveness must feel of a piece with this. |
| Approval machinery | `ApprovalCard` + ai SDK `addToolApprovalResponse` | Inline consent cards; boolean approve/decline on the wire. |
| ENG-193 proposals (parallel) | `2026-07-02-eng193-permissions-design.md` | Danger tiers (read / act / critical), split "Allow once ▾" grants, Permission Center with a "Waiting on you" inbox that already anticipates voice-routed approvals. |
| Channels seam | `flowlet-core/src/seams/channels.ts` | Message-shaped `deliver()` only — with an explicit comment: *"Realtime voice is a session, not a message — it gets its own contract at ENG-185 time."* The seam reserved this slot. |
| Topology B | platform architecture spec | Interactive host-API tools execute **in the user's browser** on the user's session. This turns out to matter enormously for voice (§8). |

*(Linear ENG-185 itself couldn't be fetched this session — Linear MCP needs re-auth. Scope above is reconstructed from the PRD, memory notes, and the orchestrator brief; worth a 30-second sanity check against the issue.)*

## 2. The spine of a voice session (common to all directions)

Whatever surface it lives on, a session has the same skeleton. Getting this right is most of the UX.

```
enter ──► LISTENING ⇄ THINKING ⇄ SPEAKING ──► exit
              ▲            │
              └── barge-in ┘        (visual surface renders in parallel throughout)
```

**Enter.** Tap the mic (the existing `VoiceButton`, un-hidden). One tap starts an **open-mic session** — not hold-to-talk. Hold-to-talk is walkie-talkie dictation by another name; the realtime APIs' server-side VAD and semantic turn detection exist precisely so the user can just talk. The mic-permission browser prompt happens here, once, with a quiet explainer line under the blob ("Vendo can hear you until you end the session").

**The three states, spoken in fluidkit's language.** One organic blob — the same metaball creature as `FluidThinking`, scaled up — is the session's face. It never disappears during a session; it changes *behavior*, not identity:

- **Listening** — the blob breathes slowly and its metaballs ripple *to the user's mic amplitude* (driven locally off the mic stream, <100 ms, no network round-trip — this is the "it hears me" feedback and it must be instant).
- **Thinking** — exactly today's `Thinking` cluster behavior (drops orbiting, gathering). Users already know this means "working."
- **Speaking** — the blob pulses to the *agent's* output amplitude, slightly brighter/warmer than listening. Listening and speaking must be distinguishable at a glance without color alone (motion character + a small mic/speaker glyph inside the blob).
- **Muted / paused** — blob settles to a still disc with a slash glyph. One tap on the blob toggles mute (the fastest possible "stop listening to me" — important for trust).

Reduced motion: the blob is replaced by the static disc + a text state label ("Listening…", "Thinking…", "Speaking…") — same enhancement-layer rules as every ENG-205 component.

**Exit.** Any of: tap the ✕ beside the blob, `Escape`, saying a natural sign-off the model recognizes ("that's all, thanks"), or ~45 s of silence → the agent asks "still there?" → another 15 s → session ends with a soft chime. The thread survives the session (see Direction A); ending voice never loses anything.

**The dual channel — one principle: *voice narrates, the surface shows*.** When the agent generates a view or takes an action mid-conversation:

- The view renders **on the visual surface** (inline in the thread / on the stage) with the existing `FluidReveal` skeleton→view morph, exactly as in text chat.
- The voice **narrates the headline, never the table**: "Here's your overdue invoices — three of them, $4,200 total. Acme's is the oldest." Reading a table aloud is the failure mode; the voice gives the top-line and points, the surface carries the detail.
- The system prompt for voice sessions encodes this division explicitly (short spoken turns, name-the-view-then-summarize, offer "want me to read them out?" instead of defaulting to it — that offer is also the eyes-free accessibility path, §7).
- Tool activity gets spoken *progress* markers only when latency is felt: "checking your calendar…" for a slow call, silence for a fast one. The visual `ToolCall`/activity affordances keep doing the precise bookkeeping.

## 3. Direction A — Voice woven into the thread *(recommended)*

Voice is a **mode of the existing thread**, not a place. Tap the mic in any composer (page tab, Cmd+K overlay, slot design-overlay) and the composer itself morphs — `FluidRipple`-style — into a **voice bar**: the blob on the left, a live caption strip in the middle, mute and end on the right.

```
   ordinary composer                       during a voice session
┌────────────────────────────┐        ┌────────────────────────────────┐
│ [⚙] [📎]  Ask anything     │  ──►   │ (◕)  "…show me overdue invo…"  │
│                    [🎙][➤] │        │ blob   live caption      [🔇][✕]│
└────────────────────────────┘        └────────────────────────────────┘
```

The conversation stays **in the thread**: each finished user utterance becomes a user message (from the realtime API's transcription), each agent turn becomes an assistant message, generated views render inline with the same `FluidReveal` reveal, approval cards appear inline (§6). The thread *is* the live transcript — captions by default, not as an afterthought.

```
┌─ thread ────────────────────────────────┐
│ 🗣 "Show me overdue invoices"           │   ← transcribed utterance
│                                         │
│ ┌─ Overdue invoices ────────────┐       │   ← generated view, FluidReveal
│ │ Acme Co      $1,200   32 days │       │
│ │ Birch LLC    $2,100   18 days │       │
│ │ Cove Inc       $900    9 days │       │
│ └───────────────────────────────┘       │
│ 🔊 "Three overdue, $4,200 total.        │   ← agent speech, captioned live
│     Acme's is a month old — want        │      word-by-word as it's spoken
│     me to chase it?"                    │
├─────────────────────────────────────────┤
│ (◕)  ~ listening ~            [🔇] [✕]  │   ← voice bar (was the composer)
└─────────────────────────────────────────┘
```

**Why this direction.** It's the honest expression of what Flowlet already is: one thread, three surfaces. Voice inherits *everything* — approval cards, saved flowlets, pin-to-card, integrations, error banners — with zero parallel surface to maintain. Network drop degrades gracefully to the very same thread in text (§5). It works identically in the slot's design overlay, which the "stage" direction can't. And it's the smallest build: the voice bar + blob states are the only new UI.

**Costs.** Less theatrical than a dedicated voice surface — the demo moment is quieter. The thread scrolls while the agent talks (auto-follow, pinned to bottom during a session). On a tiny slot overlay the caption strip is cramped.

## 4. Direction B — The Stage (voice takes the surface)

Entering voice **clears the stage**: the thread fades back, the blob floats up to become a large centered presence, and generated views appear one at a time as **full-width cards beneath the blob** while the agent narrates. A thin transcript drawer peeks from the edge for the history.

```
┌──────────────────────────────────────────────┐
│                                              │
│                  ( ◕ ◕ )                     │  ← the blob, hero-sized,
│                 ~ speaking ~                 │     amplitude-reactive
│                                              │
│   ┌─ Overdue invoices ──────────────────┐    │
│   │ Acme Co        $1,200      32 days  │    │  ← current view, center stage
│   │ Birch LLC      $2,100      18 days  │    │
│   └─────────────────────────────────────┘    │
│                                              │
│  ⌃ transcript                    [🔇]  [✕]   │
└──────────────────────────────────────────────┘
```

This is the ChatGPT-voice / Siri register: unmistakably "a voice experience," gorgeous in a launch video, and the blob at hero size is a genuinely strong brand moment for the fluid identity. The focused single-card stage also matches how people process speech — one thing at a time, narrated.

**Costs.** It's a second rendering surface: card layout, history navigation ("go back to the first view"), and approval presentation all need stage-specific treatment that duplicates what the thread already does. The slot has no room for a stage, so voice becomes page/overlay-only or inconsistent. Exiting has to reconcile the stage back into thread history (everything must land in the thread anyway, or voice sessions are amnesiac). And it makes voice feel like *an app inside the app* rather than the same agent heard aloud.

**Hybrid worth considering:** ship A's mechanics with one stolen element of B — when a view renders during a voice session, it gets a brief **spotlight** treatment (slightly scaled, elevated, the rest of the thread dimmed ~15% until the narration ends). Theater where it counts, one surface to maintain. This is my actual recommendation if A-vs-B feels like a false choice.

## 5. Direction C — The Ambient Halo (voice over the host app) *(north star, not now)*

Voice detaches from any surface: a small floating pill (blob + caption) sits above the **host application itself**, and the agent acts on whatever is relevant — updating a pinned slot card in place on the dashboard, popping the overlay only when it needs to show something new, narrating throughout. "Walk around the app while talking to it."

It's the most magical version and the truest to "it does/shows things live" — and it's premature: it needs a cross-surface session (today each surface mounts its own provider/thread), a portal/z-index contract with arbitrary host CSS, and answers about *where* views appear that we don't have data on. Recorded as the destination so A's decisions don't foreclose it (nothing in A does — a detached pill is the voice bar unmoored). Revisit post-launch.

## 6. Approvals by voice — the killer problem

Constraint from ENG-193 (adopted here as ground truth): tiers derive from tool annotations — **read** auto-allows, **act** confirms and is grantable, **critical** always confirms and is never downgraded. Voice must not weaken any of that.

The failure modes voice adds: mishearing ("yes" from the TV), barge-in ambiguity (was "yes" answering the question or the approval?), and habituation being *worse* aloud — a spoken "sure" is even more reflexive than a click.

Three options:

**Option 1 — voice-yes for everything.** Every approval, including critical, can be confirmed by saying yes. Frictionless, demo-perfect, and wrong for a bank-grade product: a misheard "yes" can move money. Rejected.

**Option 2 — tiered: voice confirms *act*, touch confirms *critical*** *(recommended)*. 

- **Act tier:** the approval card renders inline as always (the visual record), with a subtle listening ring around it. The agent asks aloud, naming the parameters: *"Ready to send the reminder to billing@acme.co — should I?"* The user's spoken yes/no is matched to the pending approval and resolves the same `addToolApprovalResponse` path a click does. The card visibly flips to its approved state ("Approved by voice ✓") so the visual and audio channels never disagree. **Affirmation matching is conservative:** clear assents only ("yes", "send it", "go ahead"); anything ambiguous ("hmm", "sure?", topic change) leaves the card pending and the agent re-asks or moves on — the card stays tappable throughout, so the hand can always settle what the ear muddled.
- **Critical tier:** the agent *announces* but cannot accept a spoken yes: *"This one I need you to confirm on screen — it's a $5,000 transfer."* The card renders with its ENG-193 critical treatment (amber, named confirm button); the session stays live while the user taps. `stepUp` tools then run the host's re-auth exactly as in text. Voice never becomes the cheap side door around the strongest gate — **the always-ask tier stays literally always-*ask*, never always-*hear*.**
- **Standing grants stay a hand gesture.** ENG-193's "always allow …" is deliberately a deliberate act; a spoken "always allow this" is the reflexive-habituation problem at its worst. The agent responds: *"You can set that up from the card"* — and the split-menu is right there. (Open question 5 revisits this.)

**Option 3 — voice announces, touch confirms everything.** Safest and simplest to build (zero voice-consent matching), but it guts the modality: every act-tier call yanks the user's hands back to the screen, and "talk to it, it does things" becomes "talk to it, then click anyway." Acceptable as a **v1 stepping stone** if consent-matching slips, not as the destination.

**Wiring note (structural, not UX):** because of Topology B, tools execute client-side through the same executor the text agent uses — the policy engine (and ENG-193's future `grantPolicy`) wraps that executor, so voice *cannot* bypass approvals even if the realtime model misbehaves; the gate is at execution, not in the model's manners. Voice approvals write the same `AuditEvent` as clicks, with `via: "voice"` recorded — they show up in ENG-193's Permission Center and (later) ENG-194's audit console.

## 7. Barge-in, latency, failure, accessibility

**Barge-in.** Native to the realtime APIs (server VAD interrupts generation). UX rules: agent speech halts within ~200 ms of the user starting to talk; the blob snaps speaking→listening; the cut-off narration's caption in the thread is marked ("— interrupted"). **Barge-in stops *speech*, never *work*:** an in-flight tool call completes (or hits its own approval gate); "stop"/"wait"/"cancel" as an utterance additionally declines any pending approval — matching the conservative-matching rule (interruption pauses, explicit words cancel).

**Latency feel.** The blob's listening ripple runs off the local mic stream — instant, regardless of network. Live partial captions in the voice bar show the system heard the words before it responds. Thinking gaps are the existing Thinking behavior, which users already read as progress. Target sub-second voice-to-voice (WebRTC path); if a response will be slow because of tool work, the agent says so ("give me a second, pulling the run history…") — silence is the killer, not delay.

**Graceful failure.** Network drop mid-utterance: the blob freezes to the static disc with a desaturated tint, soft error chime, banner in the voice bar — "Voice dropped — reconnecting…" with auto-retry (existing `friendlyError` patterns). After ~10 s: "Voice couldn't reconnect. Your conversation is saved — continue by typing, or tap to retry." Because Direction A's session *is* the thread, nothing is lost and the text composer is one tap away. Mic-permission denied: the button shows a one-line pointer to browser settings and the session never half-starts.

**Accessibility & no-voice fallback.** Voice is an enhancement layer, same doctrine as fluidkit: `useVoiceInput().supported` stays the gate (false when no relay configured, no mic, no secure context → the button hides and Flowlet is exactly today's product). Live captions are on by default — the deaf-adjacent case is served by the same feature that makes the thread the transcript. All state changes announce via `aria-live` ("Listening", "Speaking", "Approval requested"). Keyboard: shortcut to toggle the mic (proposal: `Cmd/Ctrl+Shift+K`, sibling to the overlay's `Cmd+K`), `Escape` ends, mute reachable by tab. Reduced motion: static states per §2. Eyes-free users get the inverse accommodation: "read it out" is always available, and the agent offers it when a view's headline can't carry the content.

## 8. Keeping voice in the open-source tier: the BYOK relay

**The problem.** A realtime session needs a realtime model (OpenAI Realtime over WebRTC with ephemeral tokens; Gemini Live over WebSocket), and connecting a browser to one requires a server-side secret. The PRD parks "realtime voice relay" in Flowlet cloud — taken literally, that makes voice cloud-only and breaks the embedded/OSS guarantee.

**Proposal: the relay is a seam implementation, not a cloud feature.** A new session-shaped contract lands beside `Channels` in flowlet-core (the seam file already reserves it):

```
VoiceSessions (seam, sketch — contract detail is implementation-phase work)
  createSession(principal, threadId) → { transport config + ephemeral credential,
                                         session-scoped, ~60s mint window }
```

- **`@flowlet/voice-relay`** — a small OSS server package implementing it: mints the ephemeral credential from the operator's *own* realtime API key (BYOK, exactly the embedded-runtime philosophy), stamps in the session config (voice-mode system prompt from the prompt catalog, tool definitions from the published manifest, voice + VAD settings), and writes `voice_session_started/ended` audit events. Self-hosters mount it in their backend next to the vouch endpoint. **Audio never transits the relay** — the browser talks WebRTC directly to the provider; the relay is a credential-and-config minter, which is what keeps it small enough to be credibly self-hostable.
- **Tool execution needs no relay at all.** Topology B already puts tool execution in the browser; the realtime APIs deliver tool-call events over the client connection (WebRTC data channel / WS). The browser routes them through the *same* client-executor + policy + approval machinery as text chat. This is the deep reason voice fits the architecture instead of fighting it: the security-critical path doesn't grow a new server.
- **Provider adapter inside the relay + client:** start with OpenAI Realtime (WebRTC + ephemeral tokens + function calling is the best browser fit today); the adapter boundary keeps Gemini Live (WebSocket-only) and future providers pluggable. This is also where Anthropic slots in if/when a realtime speech API ships.
- **Cloud runs the identical relay** as a hosted implementation (our key now, BYOK later — mirroring the ENG-198 runtime posture).

**What BYOK costs vs hosted, honestly:** the self-hoster runs one more endpoint, holds a second API key (realtime provider ≠ their text-model key unless same vendor), pays realtime audio rates directly (order-of-magnitude: dollars per active conversation-hour — real money at scale, and *they* need the spend caps), and owns abuse/rate limiting. Hosted centralizes metering, caps, and provider failover — at the price of voice being cloud-gated and end-user audio flowing through credentials we mint. The proposal keeps both: one relay codebase, two deployments, embedded keeps the OSS guarantee honest.

**Agent parity — the one genuinely hard architecture question.** The realtime model is a *different model* from the text-loop's. Two shapes:

- **(a) The realtime model is the agent for the session** — it gets the same tool manifest and the executor-side policy gates it. Sub-second latency, true barge-in, the real "talking to it while it works" feel. Risk: behavioral drift from the text agent (different model, different prompt discipline).
- **(b) Thin voice front over the text engine** — the realtime model only converses, delegating every substantive request to the existing runtime agent as a tool call, then narrating results. Perfect consistency and one brain to maintain; but every real request pays text-agent latency inside a voice pause, which is exactly where voice UX dies.

**Recommend (a)**, with parity enforced structurally (same manifest, same executor-side policy — the things that *must* match are shared by construction) and behavior aligned via a voice variant in the ENG-186 prompt catalog. (b) stays viable per-request: the voice agent can still call heavyweight flows (e.g., `render_view` generation could delegate) — hybrid at the tool level, not the session level.

## 9. Open questions for the brainstorm

1. **Direction — A (in-thread), B (stage), or A+spotlight hybrid?** **Recommend A with the spotlight hybrid (§4)**: one surface to maintain, voice everywhere the thread is, theater at the moment a view lands. B only if the launch demo is the overriding goal; C recorded as north star.
2. **Open-mic session vs push-to-talk?** **Open-mic with VAD** — locked by the PRD's "no dictation" spirit; hold-to-talk survives only as a *fallback interaction* on the same button if VAD misfires badly in noisy rooms (long-press = manual turn). Include in v1?  Recommend no — add if real-world noise data demands it.
3. **Approvals — Option 2 (tiered voice-consent) or Option 3 (announce-only) first?** **Recommend Option 2 as the design target**, with an explicit fallback to Option 3 if spoken-assent matching isn't reliably conservative in testing. Never Option 1.
4. **Does a spoken approval need its own repeat-back for act-tier?** (Agent restates parameters before accepting yes — "sending to billing@acme.co, yes?") **Recommend yes, always** — it's one sentence of latency and it's the voice equivalent of the card's labelled fields.
5. **Spoken standing grants ("always allow this")?** **Recommend no in v1** (hand gesture on the card, per ENG-193's deliberate-gesture principle). Revisit with usage data; if ever allowed, only with repeat-back + a Permission Center notification.
6. **The blob: is the voice presence literally the `Thinking` blob scaled up, or a sibling creature?** Same creature **(recommended)** — one liveness identity across the product; needs two new fluidkit behaviors (amplitude-reactive listening + speaking pulse), which extends the fluidkit collaboration (same upstream-candidate path as ENG-205's findings).
7. **Where does voice-mode UI generation land latency-wise?** `render_view` via the realtime model may be slow/weak at codegen. Options: realtime model calls it directly vs delegates generation to the text engine as a tool (hybrid per §8). **Recommend: design the demo around host-catalog components + saved flowlets first** (fast paths), delegate codegen; measure before optimizing.
8. **Provider for v1?** **OpenAI Realtime (WebRTC)** — ephemeral-token client auth and browser fit are decisive today; adapter seam keeps Gemini Live second. Flag: this makes voice the first Flowlet feature *requiring* a non-Anthropic key — worth a conscious yes.
9. **Session ↔ thread continuity:** does ending voice keep the thread open in text (recommended — it's the same thread), and does *starting* voice mid-text-thread carry prior context into the realtime session (recommended: yes, inject recent thread history into session config — bounded, e.g. last N turns)?
10. **Slot surface in v1?** The mic appears wherever the composer does, including slot design-overlays **(recommended — free under Direction A)** — but cramped-caption styling needs a pass. Defer slot polish if it drags.
11. **Voice choice / persona:** hosts will want the voice to fit their brand. **Recommend v1 ships one curated default voice** with the provider-voice id exposed as host config (like `productName`); no voice-cloning ambitions.
12. **Cost guardrails for self-hosters:** should the relay ship with a per-principal session-minutes cap by default? **Recommend yes, on by default with a config override** — an OSS default that protects the operator's wallet is part of the credibility of BYOK voice.

## 10. Explicitly not in this epic

- Concierge phone/SMS voice (ENG-191 — different transport, same Channels family).
- Wake words, always-listening, or voice activation outside an explicit session.
- Voice cloning / custom TTS branding beyond provider voice selection.
- Direction C's host-wide ambient pill.
- Tenant policy on voice (ENG-194 — but audit events carry `via: "voice"` from day 1 so the console inherits it).

---

*Sources for the provider landscape: [OpenAI Realtime API — WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc), [OpenAI Realtime and audio](https://developers.openai.com/api/docs/guides/realtime), [Gemini Live API overview](https://ai.google.dev/gemini-api/docs/live-api), [Realtime voice API comparison (APIScout, 2026)](https://apiscout.dev/guides/realtime-voice-ai-apis-comparison-2026).*
