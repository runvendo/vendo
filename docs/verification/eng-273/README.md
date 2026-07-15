# ENG-273 install-journey GIF matrix (Claude.ai + ChatGPT × Maple + Umami)

Captured 2026-07-15 with the Orca embedded browser against the live hosts
(`https://maple.vendo.run` and
`https://umami-production-2721.up.railway.app`). Every leg was driven as a
real user in the real web client. No cell reached the consent page: all four
park at the host demo-login wall, and both ChatGPT cells park earlier at a
seat-type wall. The Vendo door itself behaved correctly in every leg that
reached it (connector registration, discovery, DCR, authorize redirect, exact
`returnTo`/`next` login bounce).

## Matrix

| Client × Host | Outcome | Evidence | Why |
| --- | --- | --- | --- |
| Claude.ai × Maple | PARKED at host login (beats 1-2 captured) | `claude-maple-install-journey-partial.gif`, `claude-maple-01..03*.png` | Custom connector add and OAuth bounce to `maple.vendo.run/login?returnTo=<authorize>` both work. Production rejects the documented demo credentials (`yousef@maple.com` / `maple-demo` from `apps/demo-bank/README.md`): `MAPLE_DEMO_PASSWORD` is overridden on Railway and recorded nowhere outside Railway variables, which are off-limits to this capture lane. |
| Claude.ai × Umami | PARKED at host login (beats 1-2 captured) | `claude-umami-install-journey-partial.gif`, `claude-umami-01..03*.png` | Connector add and OAuth bounce to Umami login (exact `?next=<authorize>`) both work. Credentials are only retrievable via Railway variables (per `runvendo/umami` RUNBOOK.md); no documented demo account works (upstream default `admin`/`umami` rejected, the deploy seeds `DEMO_USERNAME`/`DEMO_PASSWORD`). |
| ChatGPT × Maple | PARKED at seat wall (feature unavailable) | `chatgpt-00-devmode-enabled.png`, `chatgpt-01-codex-only-seat-wall.png`, `chatgpt-02-chat-seat-wall-parked.png` | The logged-in chatgpt.com session is a Vendo Business workspace with a Codex/Work-only seat. Chat is blocked ("You don't have access to Chat on this plan"), the plugins directory is blocked ("Unlock ChatGPT access... your current seat is Codex-only"), and there is no Apps & Connectors settings section. The Developer mode toggle exists and was enabled successfully, but no connector can be added without a Chat seat. Toggle reverted after capture. |
| ChatGPT × Umami | PARKED at seat wall (feature unavailable) | same as above | Same seat wall; host-independent. |
| Cursor × Maple | PARKED (no session) | none | No cursor.com web session exists in the browser; cursor.com/dashboard bounces to the authenticator sign-in. Logging in is out of scope for this lane. |
| Cursor × Umami | PARKED (no session) | none | Same. |

## Beats captured

Claude.ai legs (both hosts, identical shape):

1. `*-01-add-connector.png` — Settings → Connectors → Add custom connector,
   name + MCP URL filled (cropped to the dialog).
2. `*-02-oauth-login.png` — after Connect: real OAuth bounce to the host's
   own login page carrying the exact authorize URL, demo credentials filled.
3. `*-03-login-wall-parked.png` — the credential wall where the leg parks.

The partial GIFs (~1.5 s/frame) stitch those three beats.

## Product findings

- **Maple loses `returnTo` on a failed login.** Arrive at
  `/login?returnTo=<authorize>`, submit a wrong password: the page re-renders
  at bare `/login` with "Email or password is incorrect." and the query is
  gone, so a subsequent successful login strands the OAuth flow instead of
  resuming authorize. Umami preserves `?next=` on failure. Worth a fix in
  `apps/demo-bank`.
- **The live Maple demo password is undocumented.** The README/seed password
  `maple-demo` is dev-only; production overrides it via `MAPLE_DEMO_PASSWORD`
  and the value exists only in Railway variables. Any real-client capture or
  external demo user hits this wall. Either publish a demo password for the
  fictional bank or document where operators fetch it.
- **Both doors are healthy up to credentials.** Unauthenticated POST to both
  `/api/vendo/mcp` endpoints returns 401 with discovery intact; Claude.ai
  registers both connectors and completes DCR + authorize redirect + login
  bounce with correct state/PKCE parameters on both hosts.

## Unblock

One of: publish/provide the Maple and Umami demo logins somewhere this lane
may read, or a human performs the two logins mid-capture. Everything else is
scripted; the remaining beats (themed consent → approve → tool call →
destructive parking → in-product approval → retry) resume from the exact
login pages captured here. ChatGPT additionally needs a seat with Chat access;
Cursor needs a logged-in cursor.com session.
