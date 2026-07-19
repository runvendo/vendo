# ENG-273 install-journey matrix (Claude.ai + ChatGPT × Maple + Umami)

Re-captured 2026-07-17 with the Orca embedded browser against the live hosts
(`https://maple.vendo.run` and `https://umami-production-2721.up.railway.app`),
using Yousef's real logged-in Claude.ai and ChatGPT sessions. This supersedes
the earlier parked run (PR #270), which was blocked on demo credentials and a
logged-out client. Both blockers are now gone: the documented public demo
logins work (Maple `yousef@maple.com` / `maple-demo`; Umami already
authenticated in-profile), and both web clients are logged in.

## Matrix

| Client × Host | Outcome | Furthest beat reached |
| --- | --- | --- |
| Claude.ai × Umami | Install journey GREEN through **tools available**; in-chat tool call blocked | connector add → themed Vendo consent → OAuth success → **9 Vendo tools registered** → (chat tool-call does not surface) |
| Claude.ai × Maple | Add + themed consent GREEN; **OAuth blocked at consent POST** | connector add → themed Vendo consent → consent POST returns **HTTP 400** |
| ChatGPT × Umami | PARKED — seat wall | connector cannot be added (see below) |
| ChatGPT × Maple | PARKED — seat wall | connector cannot be added (see below) |
| Cursor × Maple / Umami | PARKED — no session | out of scope this run |

## Beats captured

**Claude.ai × Umami** (strongest cell — full journey to tools-available):
- `claude-umami-01-add-connector.png` — Settings → Connectors → Add custom
  connector, name + `…/api/vendo/mcp` URL filled.
- `claude-umami-02-consent.png` — the themed Vendo OAuth consent page ("Allow
  Claude to access this product? … Vendo's policy, approval, and audit controls
  still apply."). Reached with no login wall (host session shared in-profile).
- `claude-umami-04-tools-available.png` — after Allow, the connector is
  **Connected** and Claude registers **all 9 Vendo tools**: Interactive tools
  (Vendo apps call / list / open) + Other tools (Get umami revenue report,
  Get umami website metrics, Get umami website stats, List umami websites, …),
  each defaulting to "Needs approval".
- `claude-umami-install-journey.gif` — add → consent → tools-available.
- `claude-umami-05-chat-tools-not-loaded.png` — the in-chat limitation (see
  findings): Claude's chat tool-search returns only Google Calendar tools; the
  registered Vendo tools never load into the chat toolset.

**Claude.ai × Maple**:
- `claude-maple-01-add-connector.png` — add custom connector, Maple MCP URL.
- `claude-maple-02-consent.png` — themed Vendo consent page renders (reached
  after the demo login now succeeds).
- `claude-maple-oauth-journey.gif` — add → consent.

**ChatGPT × both** (seat walls):
- `chatgpt-00-chat-access-wall.png` — "You don't have access to Chat on this
  plan. Your current seat is Work-only."
- `chatgpt-01-seat-type-codex.png` — Workspace → Members: the sole member's
  **Seat type: Codex** (email masked). This is the root cause of every ChatGPT
  wall in this run.
- `chatgpt-02-plugins-codex-only-wall.png` — the Plugins/connector-add surface:
  "Unlock ChatGPT access. Your current seat is Codex-only."

## Findings

1. **Both demo logins now work** — the documented public Maple credentials
   authenticate against production (the earlier `MAPLE_DEMO_PASSWORD` Railway
   override no longer blocks them), and the Umami demo session is live. The
   credential wall that parked the previous run is gone.

2. **The Vendo door OAuth is healthy up to consent on both hosts** — connector
   registration, DCR, discovery, and the authorize redirect with correct
   PKCE/state all work, and the themed consent page renders identically on
   Maple and Umami.

3. **Maple's live deploy fails the consent POST (HTTP 400).** On
   `maple.vendo.run`, submitting the consent form (`decision=approve`) returns
   `{"error":"invalid_request","error_description":"Consent interaction is
   invalid, expired, or already used"}` on the *first* submit of a freshly
   rendered consent. Umami (same door code, different deploy) completes the
   identical POST and returns to Claude with `step=success`. The consent record
   is written on the authorize-GET (`packages/mcp/src/oauth/server.ts`,
   `CONSENT_SECONDS = 600`) and looked up / atomically claimed on the POST; the
   symptom is consistent with a non-shared or non-persistent store on the Maple
   Railway deploy (record not found / not claimable across the GET→POST hop).
   This is a Maple deployment fix, not a client or door-code bug.

4. **Claude.ai does not surface the Vendo MCP tools into the chat toolset.**
   The connector connects and all 9 tools appear in Settings → Connectors, but
   in a conversation Claude's tool-search returns only Google Calendar tools and
   reports the Vendo tools "aren't loading into my available toolset." This
   reproduced across fresh chats, a full page reload, and with every other
   connector disabled for the chat (only Umami enabled). Needs investigation:
   likely Claude-side deferred-tool indexing under an account with many
   connectors, or a Chat-vs-Cowork surface distinction.

5. **ChatGPT is Codex/Work-only on this workspace seat.** The consumer "Chat"
   surface and the Plugins/connector-add surface both hard-gate behind a seat
   upgrade ("Codex-only"/"Work-only"). Enabling Developer mode (done, then
   reverted for hygiene) does not lift the gate — a custom MCP connector cannot
   be added and generated UI cannot be rendered from this seat. Contrary to the
   working assumption that the Work seat can do everything the chat seat can,
   ChatGPT itself blocks it. Resume needs a ChatGPT seat with Chat access.

## Account hygiene

Maple (Vendo) and Umami (Vendo) connectors were left connected in Claude (they
are Vendo's own demo connectors). ChatGPT Developer mode was reverted to off.
Screenshots are cropped to remove the personal chat-title sidebar; no tokens or
emails are shown.
