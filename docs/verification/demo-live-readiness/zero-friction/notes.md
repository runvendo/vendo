# zero-friction cold-profile proof — notes

Produced 2026-07-26 by `proof.ts` (see its header for how to reproduce)
against local **prod builds** (`pnpm build` + `next start`):

- Maple on :4300 — `DEMO_AUTOLOGIN=1 VENDO_BASE_URL=http://127.0.0.1:4300
  AUTH_SECRET=<local> MAPLE_DEMO_PASSWORD=<local>`
- Cadence on :4301 — `DEMO_AUTOLOGIN=1 VENDO_BASE_URL=http://127.0.0.1:4301`
  with **zero SUPABASE_\* env** (SUPABASE_URL / SUPABASE_ANON_KEY /
  SUPABASE_JWT_SECRET all unset; boot succeeded, sessions minted and
  verified locally — contract Z3)
- `VENDO_BASE_URL` is REQUIRED, not incidental: the autologin gate is
  host-bound and **fails closed** without a configured demo origin (no
  loopback exception), so every run — local or deployed — must name the
  exact origin it serves.
- Both with `ANTHROPIC_API_KEY` (deployed parity) so boot-time chip
  pre-generation fills the tap-to-attach cache. The auto-login path itself
  is key-independent (verified earlier keyless: signed-in landing + chip +
  Maple scenario card all worked with no key at all).

## Files

- `<host>-01-cold-landing-signed-in.png` — FIRST navigation of a fresh
  browser context lands on the signed-in product; navigation trail never
  touches /login; no password field ever rendered (asserted in proof.ts).
- `<host>-02-chip.png` — the "Live demo — signed in as <first name>" chip.
- `<host>-03-after-reset-still-signed-in.png` — Reset (Maple: sidebar
  button; Cadence: ⌘⇧. demo hotkey) reloads into a signed-in page, chip
  still present.
- `<host>-04-scripted-card-attached.png` — one deterministic card attached:
  Maple = "Where did my money go?" scenario (canned scripted engine),
  Cadence = "What filing deadlines hit next week?" pre-generated chip
  (instant-attach cache).
- `<host>-05-logout-continuation-signed-in.png` — the REAL sign-out flow
  (Maple: account-switcher "Sign out"; Cadence: GET /logout), whose
  continuation targets /login: with the flag active the proxy turns that
  into the signed-in product — no login form ever renders (password-field
  count asserted 0).
- `maple-06-credential-session-no-chip.png` — Z4 negative: a credential
  session on the same flag-enabled server renders NO chip. The login form
  is unreachable under the flag (by design), so the exact claim-less
  Auth.js JWE the credentials provider mints (signed with the server's
  AUTH_SECRET) is installed as the cookie; had the proxy not honored it,
  auto-mint would have put the chip up — chip absence proves the
  credential session was used. Cadence's negative is covered by unit test
  (`isAutologinToken` false for GoTrue-shaped tokens) since a credential
  login there requires a running GoTrue.
- `recordings/<host>-cold-profile.webm` — full cold-profile session video.

## Host binding (the security gate)

The autologin decision reads the **Host header only** — Railway passes the
real public host there, while `X-Forwarded-Host` is attacker-settable and
`request.url` is derived. The header is **never parsed as a URL**: it must
first match a strict bare authority (`^[A-Za-z0-9.-]+(:[0-9]{1,5})?$`, no
empty labels), and only then is it lowercased, stripped of the scheme's
default port, and compared to the `VENDO_BASE_URL` host normalized the same
way. Missing/blank Host, or no configured origin, never mints.

Why the regex comes first: `new URL("http://" + host)` accepts
`victim.example@demos.vendo.run` (userinfo), `demos.vendo.run#victim` and
`demos.vendo.run/victim`, discarding or reinterpreting everything outside
the authority — so a foreign Host would smuggle the demo host past a
`URL.host` comparison. All three minted before this fix.

Unit-tested per host: foreign Host + `X-Forwarded-Host: <demo origin>` ⇒ no
mint; missing Host ⇒ no mint; no `VENDO_BASE_URL` (even loopback) ⇒ no
mint; demo origin ⇒ mint; `DEMOS.VENDO.RUN`, `demos.vendo.run:443`,
`Demos.Vendo.Run:443` ⇒ mint, `demos.vendo.run:8443` ⇒ no mint.

Unit tests also cover every URL-smuggling form (`@`, `/`, `#`, `?`,
embedded whitespace, brackets, double colon, empty label) as explicit
no-mint cases. Leading/trailing whitespace cannot reach the gate — the
Fetch `Headers` layer strips optional whitespace (RFC 9110) before the app
sees the value.

`host-binding-probe.txt` holds the LIVE curl matrix against both prod
builds: the exact configured authority is the only value that mints;
X-Forwarded-Host spoofing, all three URL-smuggling strings, brackets,
double colon, empty label and a wrong port all refuse, with the loud
server-side warning logged per host.

## Known pre-existing (out of scope)

Maple's scripted fixture view renders "SpendingBreakdown: generated
component rendered no content" on this LOCAL boot. Verified pre-existing
and unrelated to auto-login: a credential login on the same server renders
identically (the scripted card still attaches, which is the criterion).
