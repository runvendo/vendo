# ENG-185 — Realtime voice mode: design & as-built record

> **Status: BUILT — designed with Yousef in two live sessions (2026-07-02 UX brainstorm, 2026-07-04 iteration + realtime), verified end-to-end with real speech.** UI merges only with his sign-off, per standing rules.
> Coordinated with ENG-193 (permissions tiers) and the locked platform architecture (2026-07-01). Screenshot trail in `assets/eng185-voice/`.

## 1. What's locked upstream

**PRD (2026-07-01):** straight-to-realtime bidirectional voice — the user talks, the agent talks back *and does/shows things live*. No dictation stepping stone. Linear ENG-185 confirms: same agent core/tools/permissions as chat; live rendering while speaking; barge-in; approval by voice or on-screen card; the old `useVoiceInput` stub replaced, not extended.

**OSS install model (locked 2026-07-02):** zero-infra BYO-keys — `+OPENAI_API_KEY` turns voice on; no relay server.

## 2. The decided experience (Yousef's calls — do not relitigate)

**Stage-native voice.** Mic tap → the full voice experience takes over the surface that launched it (page content area / Cmd+K panel / the slot's design overlay — the mic appears wherever a composer does). Not a chat accessory; nothing floats over host chrome.

**The stage:**
- The **blob** (the ENG-205 `Thinking` metaball, promoted, amplitude-reactive from real audio analysers) is **locked at the top**. No visible Speaking/Listening labels — motion IS the state; visible text only for Muted / Connecting… / Session ended; a screen-reader live region announces everything.
- **Captions live with the blob**: two sticky rows — your last line (quoted) and the agent's — each role in its own slot, settled lines dim instead of vanishing. Words are never dropped: an un-finalized line displaced by a new one is promoted into the transcript.
- **Views are slides.** Mandatory center-snap paging: exactly one view owns the stage at rest, dead-centered (edge spacers give deck ends true center). Off-stage neighbors **peek** at the top/bottom edges — blurred, dimmed, scaled to .78 — and animate into the frame on focus. A dot rail (right edge) shows position and jumps on tap. Tall views scroll inside their slide. Frosted blur strips dissolve content at both scroll edges.
- **Consent is edge chrome**, never a feed card: a slim bar docked above the footer (§4).
- **Transcript drawer** peeks from the footer; it auto-yields whenever a consent is pending (it once intercepted a critical confirm tap).
- **Ending ≠ leaving.** The call ends (✕, Escape, spoken sign-off via the `end_session` tool, or idle timeout) but the stage stays browsable; **Back to chat** is the explicit exit — that's when the transcript + views land in the launching surface's thread as ordinary messages (resolved consents as compact text traces). Slot-launched sessions also get **Pin this view** (pins the focused slide; post-call only — mid-call the slot overlay would tear down).

**Session spine:** open-mic with server VAD (silence window 750ms — stock settings split mid-thought pauses; `semantic_vad` stalled in testing). Barge-in halts speech ≤ the VAD's reaction, marks the caption "— interrupted", never cancels work. A `turn_detected` cancellation with no follow-up auto-revives a response after 1.8s — dead air is structurally impossible. Idle: at 45s of silence the agent asks if you're there; 20s later it hangs up. Keyboard: `Cmd/Ctrl+Shift+K` toggles a session, `Escape` ends (then leaves). Context carry-over: starting voice mid-thread injects the recent text conversation into the session.

**Reduced motion:** static disc + text state labels, dim-only (no animated blur), instant transitions — the fluidkit enhancement-layer doctrine throughout. No driver configured / no mic / no key → the mic button hides; Flowlet is exactly the text product.

## 3. Architecture — the `VoiceDriver` seam

```
VoiceDriver.start(emit, {context?}) → handle {mute, end, approve, decline, stop}
   events → reducer → VoiceSnapshot → VoiceStage (pure render)
```

- **`createScriptedVoiceDriver`** — deterministic beats (say/wait/approval/auto-yes/branch); powers demos and tests, and is the graceful fallback when the host has no realtime key.
- **`createRealtimeVoiceDriver`** — OpenAI Realtime over WebRTC: host backend mints an ephemeral client secret (`POST /v1/realtime/client_secrets`), browser exchanges SDP at `/v1/realtime/calls`, events ride the `oai-events` data channel (caption handlers tolerate GA + beta names). Audio never touches the host backend or Flowlet.
- **Tools execute client-side** (topology B): host-API tools go through the same `executeHostToolCall` chat uses, tiers derived by `annotationsToTier` — parity by construction. Display tools (`show_table`, `show_key_value`) map model-filled props onto genui payloads rendered by the real sandbox.
- **Integrations:** `list_integrations` + `request_connect` (the host Connect card on stage = the consent *and* the user gesture the OAuth popup needs). Composio ACTIONS go through the host bridge (`/api/flowlet/voice/tools`): GET returns defs + tiers for the connected toolkits (shared `ingestComposioTools`), POST executes one named call server-side — because the Composio SDK and its key are Node/server-only.

## 4. Consent (aligned with ENG-193 tiers)

- **read** — auto-allowed, silent. Composio tools mostly ship without annotation hints, so the bridge enriches by name: FETCH/GET/LIST/SEARCH/… → read; DELETE/REMOVE/… → critical; ambiguous stays act (fail-closed, "unknown stays gated").
- **act** — the consent bar docks above the footer (listening ring, one restated fact, Allow/Decline). Spoken yes resolves via the model calling `resolve_pending_approval`; a tap always wins over a pending auto-yes; a bare spoken stop-word ("stop", "cancel", "never mind") declines **deterministically** in the driver, no model manners required.
- **critical** — amber bar, named confirm button, "This can't be undone." The driver **structurally refuses** a voice resolution for critical tier and tells the model to send the user to the screen.
- **Single-pending invariant:** a new consent auto-declines any stale unanswered one — the bar shows one request, and a later "yes" can never be swallowed by something the user already moved past (learned live: an ignored fictional transfer captured a yes meant for a Gmail fetch; the fictional tool is gone too — critical coverage comes from real annotations only).
- Settled consent lingers as a transient receipt in the bar; the durable record is the transcript/thread.

## 5. What real-speech E2E testing caught (method + findings)

Test rig: macOS `say` WAVs piped through a monkeypatched `getUserMedia` (MediaStreamDestination + a faint 60 Hz hum — a source-less destination goes Opus-DTX silent and wedges server VAD). Findings, all fixed and regression-covered where testable: VAD pause-splitting + cancellation dead air; caption slot clobbering between roles; un-finalized caption loss; captions vanishing on finalize; the model preferring a Connect card over a connected toolkit's tools; raw-cents money readouts; permission nagging on reads.

## 6. Maple wiring (the reference host)

- `POST /api/flowlet/voice` mints the ephemeral secret (`OPENAI_REALTIME_MODEL`/`_VOICE` env overrides; 503 without a key → scripted fallback). `GET|POST /api/flowlet/voice/tools` is the Composio bridge. All three handlers share the chat loop's local-only gate (`FLOWLET_DEMO_PUBLIC=1` to opt a deployment in).
- The voice agent gets: Maple's 17 host-API tools, 2 display tools, 2 integration tools, plus the connected toolkits' Composio tools (capped at 40). Instructions: narrate-don't-read, dollars-not-cents, connected-toolkit tools over Connect cards, yes = most recent request, one-to-two-sentence turns; a spoken greeting opens every session.

## 7. Follow-ups (tracked, deliberately out of this epic)

1. **Reconnect is cosmetic** — a dropped WebRTC session shows the banner but doesn't re-mint/resume; the record is safe and text continues. Real resume = re-mint + fresh session + context re-injection.
2. **Server-verified consent** for the bridge (signed approval tokens) — ENG-193; today the server trusts the client's gating, same demo-grade posture as the action route.
3. **`createFlowletHandler` packaging** of the mint endpoint + bridge — the OSS release work (ENG-206).
4. **Fluidkit upstream:** true amplitude listening ripple + speaking pulse (today: speed/spread presets + scale).
5. **Stage enter/exit morph** with ENG-205 inc.3's surface-transition vocabulary; feed density collapse for very long sessions; host-configurable voice persona.
6. **Assent-quality tuning with human speech** — the rig proves correctness, not feel.
7. Concierge phone/SMS (ENG-191), wake words, voice cloning: explicitly not this epic.

---

*Provider references: [OpenAI Realtime WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc), [client_secrets reference](https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create), [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api) (adapter candidate), [webrtcHacks on gpt-realtime](https://webrtchacks.com/how-openai-does-webrtc-in-the-new-gpt-realtime/).*
