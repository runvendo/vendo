# Hosted-store session sweep 404 — findings + flowlet fix (Polish Lane B)

**PROD-IMPACT.** Until this branch lands, any keyed host (Cloud hosted store)
serving anonymous traffic hard-fails those requests in prod: the first
session registration fails closed against a route the console no longer
serves, and `wire/context.ts` awaits it un-caught. The Lane E symptom (noisy
`session sweep failed` warns each interval) is the visible edge of the same
removal.

## Root cause

Not path drift and not a missing deploy. vendo-web commit `7cd0a02`
("data-plane: records API rides the table engine", 2026-07-19, on `main`,
deployed to `console.vendo.run`) **deliberately deleted** the console's
ephemeral-session op family per a newer spec:

> The ephemeral-session op family is deleted per spec (an anonymous visitor
> is an end_user row; adoption is PUT /users/{externalId}) — its routes 404.

That conflicts with flowlet's hosted-store one-pager
(`docs/superpowers/specs/2026-07-18-hosted-store-onepager.md`, amended
2026-07-18), which specifies `POST /api/v1/store/sessions/register|adopt|stale|claim`
plus the HOST-driven TTL sweep. The two Yousef-approved specs diverged one day
apart; the console moved, the OSS client didn't.

## Expected vs actual (live, 2026-07-20, key `vnd_ec2…` OSS_CONFORMANCE)

| Route | Client expects | Prod console answers |
| --- | --- | --- |
| `POST /api/v1/store/sessions/register` | `{ ok: true }` | **bare HTML 404** (Next.js not-found page, no error envelope) |
| `POST /api/v1/store/sessions/stale` | `{ subjects: [...] }` | **bare HTML 404** |
| `POST /api/v1/store/sessions/claim` | `{ claimed: bool }` | **bare HTML 404** |
| `POST /api/v1/store/records/{c}/list` (control) | `{ records: [...] }` | `200 {"records":[]}` ✓ |
| `POST /api/v1/store/erase` (control, empty body) | validation envelope | `400 {"error":{"code":"validation","message":"Provide exactly one of subject or appId."}}` ✓ |

Condensed curl transcript:

```
$ curl -X POST https://console.vendo.run/api/v1/store/sessions/stale \
    -H "authorization: Bearer $KEY" -H "content-type: application/json" \
    -d '{"idleMs": 999999999999, "now": 1752969600000}'
HTTP 404
<!DOCTYPE html>…<title>404: This page could not be found.</title>…   ← no envelope

$ curl -X POST https://console.vendo.run/api/v1/store/records/probe_ctl/list \
    -H "authorization: Bearer $KEY" -H "content-type: application/json" -d '{"query":{}}'
HTTP 200
{"records":[]}
```

vendo-web `origin/main` tree confirms: `apps/console/app/api/v1/store/` holds
`records`, `blobs`, `schema`, `erase` — no `sessions`. The replacement surface
on main is `PUT /api/v1/users/{externalId}` (end_user upsert-seen; traits
merge; no stale/claim, no subject merge).

## flowlet fix (this branch)

The removed surface is now detected precisely and the doors go quiet instead
of failing anonymous traffic:

- `packages/vendo/src/hosted-store.ts` — session ops ride a sessions-only
  error raise: a **bare 404** (no error envelope) throws the typed
  `HostedSessionDoorsMissingError`. An enveloped 404 (`not-found` from a live
  console) and every other failure keep the existing loud mapping.
- `packages/vendo/src/server.ts` (`hostedSessionOps`) — on the typed error the
  doors disable for the process with **one** warn naming `vendo-web@7cd0a02`
  and the lost capabilities. After that: `register` no-ops (anonymous requests
  serve again), `adopt` returns `null` (cookie still retires; no merge audit),
  `sweep` returns `[]` (no per-interval retry noise).
- Live-verified against prod: `sessions.stale`/`register` throw the typed
  error; `records.list` unaffected. Covered by four new tests in
  `packages/vendo/src/hosted-sessions.test.ts` (disable-once + warn contents,
  sweep-leg quiescence, adopt/cookie path, enveloped-404 precision negative).

## What is still lost on Cloud (needs vendo-web follow-up)

With the doors gone the console has no equivalent for two contract promises:

1. **Ephemeral TTL erasure** — nothing sweeps idle anonymous subjects' rows on
   the hosted store. `POST /api/v1/store/erase` still exists, but the host has
   no stale/claim legs to drive it. Anonymous data now accumulates until an
   explicit erase.
2. **Anonymous→signed-in merge** — `PUT /users/{externalId}` identifies a
   user but moves no store rows; the anon session's threads/apps/state stay
   orphaned under `anonymous_<id>`.

Two fix directions for vendo-web (pick one):

- **A. Restore the session doors over the new engine** — reimplement
  `sessions/[op]` on top of end_users + the data plane (register =
  upsert-seen; adopt = end_user identify + server-side subject merge; stale/
  claim = last_seen predicate). Keeps the flowlet client and the one-pager
  contract as written; the flowlet detection then simply never fires.
- **B. Finish the new contract** — add a server-side TTL lifecycle for
  anonymous end_users (console-owned sweep + erase cascade) and a subject-merge
  door (or fold merge into `PUT /users/{externalId}` with a `mergeFrom`
  field), then migrate flowlet's `hostedSessionOps` onto it and amend the
  one-pager.

Either way the flowlet-side graceful disable stays correct: it reacts only to
the removed surface and re-arms automatically on any console that serves the
doors again (detection is per-process, not persisted).
