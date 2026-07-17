# Principals and orgs

Who the agent acts as. The host resolves its own session to a principal
(`createVendo({ principal })`); everything below is what Vendo does around
that seam.

## Anonymous sessions and sign-in

When `principal(req)` returns `null`, the visitor gets a per-client ephemeral
principal carried by a signed httpOnly cookie. Nothing an anonymous session
touches lands on disk.

**Sessions expire.** Every request touches the session; a session idle past
`sessions.ttlMs` (default 30 minutes) is evicted — its in-memory data
(threads, apps, state, grants, approvals) is discarded in one cascade. A
request still in flight holds its session open, however long the turn streams.
The cookie itself stays valid: the next request simply gets a fresh, empty
session. A write that races an eviction fails closed with `not-found`
("session may have expired") rather than landing on disk. Tune with
`createVendo({ sessions: { ttlMs, sweepIntervalMs, maxSessions } })`;
`ttlMs: 0` disables TTL eviction (the `maxSessions` cap still applies).
Sessions are per-process: multi-instance deployments need sticky routing for
anonymous traffic.

**Auto-merge on sign-in.** The first authenticated request that still carries
a valid anonymous-session cookie adopts that session's work into the signed-in
subject, then retires the cookie. The merge is idempotent, and an existing row
always wins over the anonymous copy — a colliding id is skipped, never stolen.

What migrates: threads, apps (with their per-app record and blob collections),
and per-app state.

What deliberately does NOT migrate — consent doesn't transfer identities:

- **Grants and approvals.** The anonymous session's permission grants and
  pending approvals evaporate; users re-approve as themselves.
- **Connected accounts.** Composio connections are keyed by subject (and
  anonymous sessions can't hold them anyway); users connect as themselves.
- **Audit and run history.** History records what the anonymous principal
  did; it is not rewritten.

Every merge emits a `kind: "principal"` audit event
(`detail.event: "anon-merge"`) with what moved.

## Away re-verification rides actAs

Away execution (automations firing with no live session) authenticates through
the host's `actAs` seam with the grant captured while the user was present.
Re-verification is the seam itself: **the host declining to mint (`actAs`
returns `null`) fails the run closed** — the step errors, the run stops, and
nothing reaches the host API. There is no second verification seam to
configure. Every actAs-authenticated call audits its disposition in
`detail.actAs` (`minted`, `declined`, `mismatch`, or `error`).

## Reserved subject namespace

Subjects starting with `vendo:` are runtime-minted only:

- webhook trigger principals are `vendo:webhook:<source>`,
- `vendo:org:<orgId>` is reserved for Vendo Cloud organization workspaces
  (see below) — the OSS wire never mints this subject itself.

Host principal resolvers are forbidden from producing reserved subjects (and
from minting `kind: "org"` principals); the wire rejects both loudly.
Reserved subjects can never hold connected accounts.

## Orgs (Vendo Cloud)

Organization workspaces — shared apps, approvals, and grants under one org
subject — are a [Vendo Cloud](https://vendo.run) capability, not an OSS wire
feature. The self-hosted wire always answers every `/api/vendo/orgs` route,
and any `?org=<id>` param on `/api/vendo/approvals` or `/api/vendo/grants`,
with a `cloud-required` posture error (`402`) — unconditionally, regardless
of `VENDO_API_KEY`. `GET /api/vendo/status` reports no `orgs` block.

Vendo Cloud manages its own accounts, members, and org-scoped keys
server-side; see `vendo cloud whoami`, `vendo cloud members`, and `--org`
key scoping in the CLI reference for the Cloud-side org model.
