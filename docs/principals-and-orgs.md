# Principals and orgs

Who the agent acts as. The host resolves its own session to a principal
(`createVendo({ principal })`); everything below is what Vendo does around
that seam.

## Anonymous sessions and sign-in

When `principal(req)` returns `null`, the visitor gets a per-client ephemeral
principal carried by a signed httpOnly cookie. Nothing an anonymous session
touches lands on disk.

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
- org principals are `vendo:org:<orgId>`.

Host principal resolvers are forbidden from producing reserved subjects (and
from minting `kind: "org"` principals — org context is derived from
membership); the wire rejects both loudly. Reserved subjects can never hold
connected accounts or org membership.

## Orgs (Vendo Cloud)

Full org semantics ship in the OSS packages — `vendo_orgs` +
`vendo_org_members` tables, `kind: "org"` principals, org-owned apps and
automations, management chrome — but **activation is key-gated**: set
`VENDO_API_KEY` for a plan with the `orgs` capability (validated through the
console's `/keys/validate`). Without it, every org API returns a
`cloud-required` posture error, and `GET /api/vendo/status` reports
`blocks.orgs: false`.

Roles: **members run, admins approve and manage, owners control the owner
set.** An org can never lose its last owner (except through the store erase
API, where full erasure wins).

- `POST /api/vendo/orgs` — create (caller becomes owner)
- `GET /api/vendo/orgs` · `GET /api/vendo/orgs/:id` — list / members
- `POST /api/vendo/orgs/:id/members` · `PATCH|DELETE /api/vendo/orgs/:id/members/:subject`
- `POST /api/vendo/orgs/:id/apps` — transfer one of your apps to the org

An org-owned app runs with the org principal; the human behind the request
rides along as `actor` and lands in the audit trail (`detail.org`). Grants and
approvals for org apps live under the org subject — org approvals are decided
on the admin-gated surfaces (`GET /api/vendo/approvals?org=<id>`,
`POST /api/vendo/approvals/decide` with `org`), and standing grants are
managed the same way (`/api/vendo/grants?org=<id>`). Transferring an app does
not transfer grants: the org re-approves as itself.
