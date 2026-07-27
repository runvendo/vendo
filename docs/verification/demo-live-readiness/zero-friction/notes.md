# zero-friction cold-profile proof — notes

Produced 2026-07-26 by `proof.ts` (see its header for how to reproduce)
against local **prod builds** (`pnpm build` + `next start`):

- Maple on :4300 — `DEMO_AUTOLOGIN=1 AUTH_SECRET=<local> MAPLE_DEMO_PASSWORD=<local>`
- Cadence on :4301 — `DEMO_AUTOLOGIN=1` with **zero SUPABASE_\* env**
  (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_JWT_SECRET all unset;
  boot succeeded, sessions minted and verified locally — contract Z3)
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
- `maple-05-credential-login-no-chip.png` — Z4 negative: a real credential
  login on the same flag-enabled server renders NO chip (chip count
  asserted 0). Cadence's negative is covered by unit test
  (`isAutologinToken` false for GoTrue-shaped tokens) since a credential
  login there requires a running GoTrue.
- `recordings/<host>-cold-profile.webm` — full cold-profile session video.

## Known pre-existing (out of scope)

Maple's scripted fixture view renders "SpendingBreakdown: generated
component rendered no content" on this LOCAL boot. Verified pre-existing
and unrelated to auto-login: a credential login on the same server renders
identically (the scripted card still attaches, which is the criterion).
