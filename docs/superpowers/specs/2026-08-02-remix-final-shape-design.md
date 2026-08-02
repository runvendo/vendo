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
  version mounts natively in the page (see Review below).
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
- Known jail costs accepted for instant-kind remixes: frame weight per fork,
  clipped overlays at the boundary, client-only first paint. Review-kind
  components get zero-seam native execution through approval (below).

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

## Review: two component kinds, review buys the venue (Yousef 2026-08-02)

Review NEVER affects who can see a remix — remixes are personal, always. It
decides only sandboxed-vs-in-place. Each wrapped component is one of exactly
two kinds:

```tsx
<Remixable>            {/* instant: remix appears immediately, runs SANDBOXED,
  <NetWorthCard />        forever. No review process exists for it. */}
</Remixable>

<Remixable review>     {/* reviewed: the user sees NOTHING until a host
  <TransferPanel />       reviewer approves; the approved version then renders
</Remixable>              IN PLACE as real code. */}
```

- **Instant** (default): remix → it renders, jailed, done. No queue, no
  pending state, no approval ceremony — there is nothing to signal. The ✦
  mark on the remixed component is the management handle (revert, edit).
- **Reviewed**: after remixing, the original stays and the only user-visible
  state is "sent for review" (surfaced in the panel). On approval the remix
  appears in place, native. On rejection the reviewer's note lands in the
  panel; the work is not deleted — the user can edit and resubmit.
- **Edits to an approved remix go back through review.** Until the new
  version is approved, the LAST approved version keeps rendering — never a
  gap, never unreviewed code in place. This rides the existing hash-pinned
  in-client approval machinery (`packages/apps/src/inclient.ts`): only a
  stored approval matching a version's content hash mounts in the host page.

Fixed gates regardless of kind:

| Scope | Execution | Review |
|---|---|---|
| Personal, instant component | Jail, that user only | None, ever |
| Personal, reviewed component | Host page, that user only | Ship-diff approved before the user sees it |
| Shared with other users | Per component kind | Ship-diff approved before sharing, always (see Sharing) |
| Promoted by the host | Host codebase | Host engineers review like any code change, always |

The ship-diff (`packages/apps/src/ship-diff.ts` — the fork's unified diff
against the captured baseline, keyed to a version hash) is the review artifact
at every gate. Approving is one screen: the user's version rendered live next
to the host's original, the exact code diff one tap away, approve/reject with
a note (Yousef's pick). Self-hosters get the approval seam; Cloud's console is
the ready-made review screen (the usual OSS/Cloud split).

**Fork-quality warning at sync time:** capture analyzes the wrapped component
for reach into host plumbing (router, context, callback props) and warns the
host developer — suggesting `review` for plumbing-heavy components, so the
policy is learned exactly where it would be gotten wrong.

## Sharing (Yousef 2026-08-02: in scope, rides wave 3)

Sharing a remix = sharing an app that contains a fork, on the wave-3 rebuild
primitives (grants to user/team/org, `can()`, the share dialog) — nothing new
is built. Remix adds ONE rule: an app containing a fork can be shared only
when its current version has an approval; otherwise the share dialog shows
"needs review first" and can request it. Built as the FINAL wave, after the
rebuild cutover lands on main, coordinated with the wave-3 orchestrator
session.

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
- New sharing machinery of any kind — sharing reuses wave-3 primitives only.

## Sequencing

1. Pins/placements split + migration (small, unblocks an honest eval).
2. The `<Remixable>`-as-registration build (sync scan, in-place fork mount,
   chip removal, old-API deletion, idempotent fork route, the two component
   kinds + review flow, console review screen seam).
3. Frozen REMIX eval re-run → graduation decision.
4. Housekeeping PR.
5. Sharing wave — after the rebuild cutover lands on main, on wave-3 grants.
