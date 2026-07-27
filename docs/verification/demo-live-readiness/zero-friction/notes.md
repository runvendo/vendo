# zero-friction cold-profile proof — notes

Produced 2026-07-26 by `proof.ts` (see its header for how to reproduce)
against local **prod builds** (`pnpm build` + `next start`):

- Maple on :4300 — `DEMO_AUTOLOGIN=1 VENDO_BASE_URL=http://127.0.0.1:4300
  AUTH_SECRET=<local> MAPLE_DEMO_PASSWORD=<local>`
- Cadence on :4301 — `DEMO_AUTOLOGIN=1 VENDO_BASE_URL=http://127.0.0.1:4301`
  with **zero SUPABASE_\* env** (SUPABASE_URL / SUPABASE_ANON_KEY /
  SUPABASE_JWT_SECRET all unset; boot succeeded, sessions minted and
  verified locally — contract Z3)
### Deploy configuration this lane requires

- `DEMO_AUTOLOGIN=1` on both demo deployments.
- `VENDO_BASE_URL` set to the exact public origin each one serves.
- **Cadence still needs `SUPABASE_JWT_SECRET`** (any strong random value).
  Auto-login drops the GoTrue dependency — `SUPABASE_URL` and
  `SUPABASE_ANON_KEY` are no longer required — but NOT the signing key: the
  session verifier trusts any HS256 token signed with it, and the
  development default is published in this repository, so falling back to it
  on a deployment would let anyone forge an authenticated seeded-user
  session regardless of the host gate. Caught by Greptile on PR #627 (P1)
  after I had over-loosened the assertion past what the contract asked for;
  the contract only ever said URL and ANON_KEY.

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

### X-Forwarded-Host agreement, and the accepted residual

Host is the source of truth (it is what the edge routed on). When
`X-Forwarded-Host` IS present — Railway's edge always sets it — it must
AGREE with Host after the same normalization, and both must equal the
configured origin. XFH is never a source of truth; the agreement check can
only make the gate stricter. A duplicate Host smuggled past an upstream hop
fails it, because the value the edge recorded and the value we see diverge.

Every ambiguity the runtime lets us observe is refused: more than one Host
(or XFH) entry, or a comma-joined value, and the gate does not guess which
one routed — it refuses.

**Known residual, accepted (measured, not assumed).** Over a real HTTP
connection Node's parser keeps the FIRST Host field and discards the rest;
it does not comma-join them. So on a request sent straight to the origin
with two Host fields and no XFH, the app sees only the first value and
decides on that — it mints if that value is the configured origin. The live
matrix records this row honestly as MINTED rather than hiding it.

Why that is acceptable here: the dangerous version of this is an upstream
hop routing on a *different* Host value than the one Node hands us, and
that is exactly what the XFH agreement check catches — the matrix shows the
same duplicate refused as soon as the edge's X-Forwarded-Host names the
smuggled host, and Railway's edge always sets XFH. What remains is a pure
parser differential in a hop upstream of the app that also forwards no XFH;
it is not observable from inside the app, since we cannot see a header the
runtime already dropped. Blast radius is a demo session on a demo host, and
this gate is defense in depth — not the security boundary of any customer
deployment.

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

## Returning visitors with a stale cookie

The minted cookie REPLACES any existing session cookie in the forwarded
request rather than being appended after it. Both hosts' cookie readers take
the FIRST match, so appending would leave an expired or corrupted value
winning and the first render signed out — exactly the promise Z1 makes.
Unrelated cookies are preserved. Caught by Greptile on PR #627 (P1);
regression tests per host cover both the replacement and the preservation.

## Known pre-existing (out of scope)

Maple's scripted fixture view renders "SpendingBreakdown: generated
component rendered no content" on this LOCAL boot. Verified pre-existing
and unrelated to auto-login: a credential login on the same server renders
identically (the scripted card still attaches, which is the criterion).
