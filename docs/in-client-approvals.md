# In-client approvals: ship-diff, hash pinning, and the host-page mount

App UI renders in a sandboxed iframe by default. The **in-client venue**
(contract 06-apps §9) lets one exact, host-approved app version render natively
in the host page instead — with host-page authority, because a human reviewed
exactly what ships. The approval pins the version's content hash; any new
version drops back to the sandbox until it is re-approved.

The split (locked design, 2026-07-14): **OSS carries the enforcement
machinery** — the approval record format, hash-pin verification, the host-page
mount, and the automatic drop-back. **Vendo Cloud owns the human review console
that mints approvals** in production. Locally (demos, development), you inject
approval records through the documented seam below.

## The pieces

### 1. The version hash

`appVersionHash(doc)` (exported from `@vendoai/apps`) is a SHA-256 over the
app document's canonical content, excluding only copy identity (`id`,
`forkedFrom`). Every content edit — tree, components, name, server snapshot —
produces a new hash, so re-approval on version change holds by construction.

### 2. The ship-diff (what the reviewer reads)

`GET /api/vendo/apps/:id/ship-diff` (owner-scoped; also
`vendo.apps.inClient.shipDiff(appId, ctx)` server-side and
`client.apps.shipDiff(id)` from `@vendoai/ui`):

```jsonc
{
  "appId": "app_…",
  "versionHash": "sha256:…",          // the hash an approval would pin
  "pins": [{                           // forked host components (06 §8)
    "slot": "net-worth-card",
    "component": "PinnedNetWorthCard1a2b3c4d",
    "baseHash": "sha256:…",           // baseline the fork was made from
    "baselineHash": "sha256:…",       // currently captured baseline (absent = missing)
    "drifted": false,                  // host changed under the pin, or baseline missing
    "diff": "--- a/…\n+++ b/…\n@@ …"  // unified diff, captured host source → shipped fork
  }],
  "generated": [{                      // net-new generated components (no baseline)
    "component": "FreshChart",
    "diff": "--- …\n+++ …\n@@ -0,0 +1,N @@\n+…"  // whole source, as additions
  }]
}
```

### 3. The approval record (OSS verifies, Cloud mints)

`InClientApproval` (06-apps §9, zod schema `inClientApprovalSchema` in
`@vendoai/apps`):

```ts
{ appId: AppId; versionHash: string; approvedBy: string; at: IsoDateTime }
```

Records are stored via the composition's store (collection
`vendo_inclient_approvals`) and kept as an audit trail — one record per
approved version. Corrupt or mismatched records can never grant a mount.

### 4. Verification and the wire verdict

On every `open()`, the apps runtime hashes the *current* document and checks
the stored approvals. The verdict rides the tree payload additively as
`payload.inClient` and is **server-authoritative** — the runtime strips any
`inClient` field a stored, imported, or model-generated tree carries before
attaching its own verdict:

- a stored approval matches the current hash →
  `{ granted: true, versionHash, approvedBy, at }`
- approvals exist but none match (the app changed) →
  `{ granted: false, versionHash, reason: "version-changed" }`
- no approvals → no field at all (the universal default)

### 5. Enforcement in the renderer (`@vendoai/ui`)

`TreeView` mounts generated components in the host page **only** when
`payload.inClient.granted === true` — evaluation mirrors the jail's closed
module space (React + captured sub-sources, nothing else), but runs with
host-page authority. Every other state renders the sandboxed iframe jail:

- missing/invalid approval → jail (default; nothing to announce),
- `version-changed` → jail **plus a loud in-surface notice** ("In-client
  approval invalidated … until the new version is re-approved"),
- a compile or render failure of an approved component → drops back to the
  jail with an error notice; the surface never breaks.

In-thread app surfaces (conversation previews) are never the approved venue;
the thread renderer strips the field unconditionally.

## Injecting an approval locally (the Cloud-console stand-in)

Development compositions only (`createVendo({ development: … })` or
`NODE_ENV=development`); production handlers 404 this path. Requires a
host-resolved principal that owns the app — anonymous sessions are refused:

```bash
curl -X POST http://localhost:3000/api/vendo/dev/inclient-approval \
  -H "content-type: application/json" \
  -b "$HOST_SESSION_COOKIE" \
  -d '{ "appId": "app_…", "approvedBy": "local-review" }'
```

The route hashes the app's **current** version and stores the record — you
approve what is there right now, never a hand-crafted hash. `approvedBy`
defaults to `"local-dev"`. The same seam exists server-side for host code and
tests: `vendo.apps.inClient.approve({ appId, approvedBy }, ctx)`; inspect with
`vendo.apps.inClient.verdict(appId, ctx)` / `.approvals(appId, ctx)`.

## The demo journey

Fork a remixable host component → edit it → `GET /apps/:id/ship-diff` shows
the reviewable delta → inject the approval → `open()` grants the host-page
mount, pinned to that hash → any further edit changes the hash → the surface
drops back to the sandbox, loudly → re-approve the new version.

Verified end-to-end in `packages/vendo/src/inclient.fixture.test.ts` and in a
real browser by `packages/ui/e2e/inclient.spec.ts`
(screenshot: `docs/verification/eng-288-m4/01-inclient-venue-harness.png`).

## Drift and rebase (host component changed under a fork)

When the host edits a remixable component and re-runs `vendo sync`, every fork
pinned to the old capture is **drifted**: its `pins[].base` no longer matches
the loaded baseline hash. Drift is loud everywhere the app rides:

- `vendo sync` reports the slot under `pins.drifted`.
- `GET /apps/:id/pin-drift` (and `vendo.apps.pins.drift(appId, ctx)`) returns
  `[{ slot, component, baseHash, baselineHash?, reason }]`.
- `open()` payloads carry the same report as `payload.pinDrift`
  (server-written, like `inClient`); the tree renderer shows an in-surface
  notice above the tree while the fork keeps rendering in its sandbox.
- Edit results carry `driftedPins`; the ship-diff marks the pin `drifted`,
  which fail-closes review.

**Rebase** re-forks the pin from the NEW captured baseline and replays the
fork's recorded edit intents, in order, through the real model edit path —
producing a new version whose `pins[].base` is the new baseline hash:

```
POST {base}/apps/:id/rebase-pin      { "slot": "net-worth-card" }
```

Server-side: `vendo.apps.pins.rebase({ appId, slot }, ctx)`; in conversation,
the agent tool `vendo_apps_rebase_pin`. A rebase rewrites content, so it is
never invoked automatically — drift only ever *suggests* it. Failure is
all-or-nothing: if any intent fails to replay, nothing is persisted and the
result reports `replayed` / `failed` / `remaining`. A successful rebase is a
new version, so an existing in-client approval stops granting until the
rebased version is re-approved (the invariant above).

Verified end-to-end in `packages/vendo/src/drift-rebase.fixture.test.ts` and
in a real browser by `packages/ui/e2e/pin-drift.spec.ts`
(screenshot: `docs/verification/eng-288-m5/01-pin-drift-notice-harness.png`).
