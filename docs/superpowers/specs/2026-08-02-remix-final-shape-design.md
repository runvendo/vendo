# Remix — the final shape (2026-08-02)

Decided with Yousef 2026-08-02. This spec settles the end-state of the remix
use case: one concept, one API, one honest data model, and a review boundary
placed where blast radius begins. It supersedes the split personality that
shipped across the July waves (`remixable: true` registry captures + the
`<Remixable>` grounding chip from #714).

## The product promise

**Remix always means fork.** A remix starts from the host's real component,
copied byte-for-byte by the engine — never regenerated, never retyped by the
model. There is no graded-fidelity mode: a surface either forks or it has no
remix affordance at all.

Consequences:

- The context-chip behavior `<Remixable>` has today (open the composer with a
  "REMIXING · <surface>" chip, no fork) **dies entirely**. No rename, no
  fallback. `openVendoConversation({ remix })` and the chip plumbing are
  removed.
- The gesture-owned-forking law from 2026-07-21 is unchanged and remains the
  trust foundation: the engine copies, the model only edits afterwards.

## The API: `<Remixable>` is the whole surface

The wrapper becomes the registration. One line, one sync run:

```tsx
<Remixable>
  <NetWorthCard accounts={accounts} />
</Remixable>
```

- `vendo sync` scans host source for `<Remixable>` usages, resolves the child
  through its import (same static source analysis capture already performs),
  and snapshots it into `.vendo/remixable/` — source, local imports
  (`subSources`), stylesheets (`styles`), hash.
- **Constraint (defended, not hidden):** the wrapped child must be a single,
  statically importable component. Arbitrary inline JSX is a **loud sync-time
  error** whose message says: extract a component and wrap that. No silent
  degradation of any kind.
- **Removed:** the catalog `remixable: true` flag, `VendoSlot`'s `remix` flag,
  and the runtime-capture browser helper (`packages/vendo/src/remixable.ts`,
  `runtime-capture.ts`) — its baselines were strictly weaker (no subSources /
  styles / sampleProps) and the wrapper replaces its reason to exist. Remix is
  experimental, so these are deleted without a deprecation cycle.
- `VendoSlot` returns to its one job: mounting brand-new generated apps.

## Rendering: in place, in the jail, with real data

- The fork **replaces the wrapped element in place**, for that user only. The
  wrapper (`data-vendo-remixable`) is the mount boundary; the host page morphs
  per user. No slot required.
- An **unapproved** fork always renders inside the jail (sandboxed iframe,
  locked CSP) — the frame is the only real security boundary a browser offers,
  and unreviewed model-edited code never runs in-process. A **host-approved**
  version mounts natively in the page (see Review below); the jail is the
  draft venue, not a permanent ceiling.
- **Data is real, two routes:**
  1. In place, the live (JSON-serializable) props the host passes at the call
     site flow across the frame boundary into the fork. Nothing captured,
     nothing stale.
  2. Anything beyond that — edits wanting data the original never received, or
     a fork placed on a dashboard away from the host page — the agent binds
     through the host's API as that user, exactly like any generated app.
- Host **functions do not cross** (callbacks, router, context plumbing).
  Behavior is rewired through the API; that is the accepted trade for the
  boundary. Declared `sampleProps` die with the registry flag; the fork's seed
  for the dashboard-placement edge case is a snapshot of the serializable live
  props at the wrapper, taken at fork time.
- Known jail costs accepted for drafts: frame weight per fork, clipped
  overlays at the boundary, client-only first paint. Approval (below) is the
  path to zero-seam native execution.

## Data model: pins vs placements

Today one array (`doc.pins`, `Pin { slot, base }`) stores two unrelated facts,
forcing the dashboard-pin path to fabricate `base` hashes and triggering false
drift warnings. Split:

```ts
pins:       [{ slot: "MapleNetWorthCard", base: "sha256:abc…" }]  // fork provenance ONLY
placements: ["home-hero"]                                          // "show this app in that slot"
```

- `pins` feeds drift detection, ship-diff, and rebase — provenance, nothing
  else. `placements` feeds slot discovery (`useSlotApp`) — location, nothing
  else. A "place" is a host-authored name (`VendoSlot` id), never a DOM path.
- An in-place fork needs **no placement** — its location is the wrapper it
  replaced.
- **One-time migration** of stored apps: a pin whose `base` matches a known
  captured baseline hash stays a pin; every other entry becomes a placement.
  Fail closed: an entry that matches neither pattern is surfaced, not guessed.
- The demo-bank fake-hash workaround and the orphan `home-hero.json` baseline
  are deleted with the split.

## Review: draft → approved, and review buys the venue (Yousef 2026-08-02)

A remix has two states, and host review moves it between them:

```
user remixes ──► DRAFT: instantly visible, jailed (self-contained behavior
    │                   works; reach into host plumbing is degraded)
    │  host reviews the ship-diff, approves
    ▼
APPROVED: that exact version mounts IN THE HOST PAGE — native, in place,
    │     full functionality, hash-pinned to the reviewed version
    │  user edits again
    ▼
back to DRAFT (jailed) until re-approved — fail-closed by construction
```

This rides the existing in-client approval machinery
(`packages/apps/src/inclient.ts`): jailed is the default venue; only a stored
approval matching the CURRENT version's content hash mounts the UI in the host
page; any hash mismatch drops back to the iframe. Review is not bureaucracy —
it is what makes a remix fully real. The sandbox is the draft state, not a
permanent ceiling.

**The policy is per-component, on the wrapper** — because remixability varies
by component (Yousef: a self-contained chart forks cleanly; a plumbing-heavy
panel does not):

```tsx
<Remixable>                      {/* default: drafts="instant" */}
  <NetWorthCard accounts={accounts} />
</Remixable>

<Remixable drafts="held">        {/* remixes wait for host approval */}
  <TransferPanel />
</Remixable>
```

- `drafts="instant"` (default): the jailed draft renders immediately;
  approval upgrades that exact version to native in place.
- `drafts="held"`: the user sees "sent for review"; nothing renders until a
  reviewer approves, and it then mounts native directly.

The blast-radius gates are fixed regardless of the knob:

| Scope of a remix | Execution | Review |
|---|---|---|
| Personal draft | Jail, that user only | None (visible per the wrapper's `drafts`) |
| Personal approved | Host page, that user only | Ship-diff approved, hash-pinned |
| Shared with other users | Per approval state | Ship-diff reviewed before others see it, always |
| Promoted by the host | Host codebase | Host engineers review like any code change, always |

The ship-diff (`packages/apps/src/ship-diff.ts` — the fork's unified diff
against the captured baseline, keyed to a version hash) is the review artifact
at every gate. Approving is one screen: the diff, approve/reject. Self-hosters
wire the approval seam themselves; Cloud's console is the ready-made review
screen (the usual OSS/Cloud split).

**Fork-quality warning at sync time:** capture analyzes the wrapped component
for reach into host plumbing (router, context, callback props) and warns the
host developer — including suggesting `drafts="held"` for plumbing-heavy
components, so the policy is learned exactly where it would be gotten wrong.
The frozen eval measures whether draft-quality forks satisfy or the default
must flip.

## Also folded into this shape

- **Fork idempotency:** the appId-less `POST /apps/fork-pin` currently mints a
  new app on every call (UI latch is the only guard). The route gains a
  server-side dedupe per (user, wrapper) so a double-tap can never mint a
  duplicate; the latch becomes cosmetic.
- **Graduation gate:** "experimental" stays a label until the frozen REMIX
  eval is re-run and scores the redesigned journey (ledger is still 2/12,
  pre-redesign). The eval re-run happens **after** the pins/placements split
  (score the honest model, not the workarounds) and per its own frozen
  protocol — nothing in this spec tunes against it.
- **Housekeeping riding along:** the three stale doc sections (duplicated
  remix section in `docs-site/connect/host-components.mdx`, the dead exit-2
  claim in `cli.mdx`, the deleted-init-picker section in
  `docs/host-components.md`), the never-emitted `remixOffered/Wrapped/Skipped`
  telemetry events, and the CSP-blocked `@import` console noise (eval F5).

## Out of scope

- The eval re-run itself (own protocol, own run doc).
- Vendor-authored distribution / ship-app endgame beyond the promote gate
  (see the embedded-agent architecture spec).
- Any change to generation or the edit dialect.

## Sequencing

1. Pins/placements split + migration (small, unblocks an honest eval).
2. The `<Remixable>`-as-registration build (sync scan, in-place fork mount,
   chip removal, old-API deletion, idempotent fork route).
3. Frozen REMIX eval re-run → graduation decision.
4. Housekeeping PR.
