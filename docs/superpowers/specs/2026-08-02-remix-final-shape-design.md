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
- The fork always renders inside the jail (sandboxed iframe, locked CSP).
  **In-process execution of user remixes is ruled out** — the frame is the
  only real security boundary a browser offers, and in-process model-edited
  code would force review before first render, killing instant remix.
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
- Known jail costs accepted with the ruling: frame weight per fork, clipped
  overlays at the boundary, client-only first paint. The reviewed **promote**
  path (below) is the escape hatch to zero-seam native code.

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

## Review: a host policy knob (Yousef 2026-08-02)

Personal-remix review is **configurable by the host**:

```ts
remix: { review: "none" | "required" }   // default: "none"
```

- `"none"` (default): a personal remix renders instantly, jailed, that user
  only.
- `"required"`: the remix is created but held; the user sees "sent for
  review" and the fork renders only after a host reviewer approves its
  ship-diff. Execution stays jailed either way — approval controls *when* the
  user sees it, never whether it runs in-process.

Independent of the knob, the blast-radius gates are fixed:

| Scope of a remix | Execution | Review |
|---|---|---|
| Personal | Jail, that user only | Per the host's `review` knob |
| Shared with other users | Jail, wider audience | Ship-diff reviewed before others see it, always |
| Promoted by the host | Real host code, in-process | Host engineers review the ship-diff like any code change, always |

The ship-diff (`packages/apps/src/ship-diff.ts` — the fork's unified diff
against the captured baseline, keyed to a version hash) is the review artifact
at every gate. The sandbox is the nursery; promotion is the graduation.

**Fork-quality warning at sync time:** capture analyzes the wrapped component
for reach into host plumbing (router, context, callback props) and warns the
host developer that such a component will fork with degraded behavior — bad
remix candidates get caught before they ever ship a sparkle. This is the
mitigation for missing-functionality disappointment; the frozen eval measures
whether it suffices or the `review` default must flip.

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
