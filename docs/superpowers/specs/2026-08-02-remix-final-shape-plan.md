# Remix final shape — executor plan (2026-08-02)

Executes `2026-08-02-remix-final-shape-design.md` (approved by Yousef
2026-08-02, with the console mockup `...remix-review-console-mockup.html`).
Nothing outside this plan gets built. Frozen checklist = session task list
W0–W4; only the driving session flips items, only with proof.

## Frozen contract (all lanes build against this; amendments only via the
## driving session, logged here)

- **Wrapper API** (`@vendoai/ui`):
  `<Remixable review?: boolean>{child}</Remixable>` — no other props beyond
  today's `name`/`context` REMOVED (the grounding chip dies; `name` is no
  longer needed: the captured component's exported name is the slot name).
  `data-vendo-remixable=<slot>` stays the DOM boundary.
- **Slot naming**: the captured component's exported identifier (e.g.
  `NetWorthCard`), exactly as the registry name works today. Collisions
  (two wrappers, same component) are ONE capture, many mount points — legal.
- **Capture format**: `PinBaseline` unchanged (`pins.ts`), except
  `sampleProps` is no longer written by sync; schema keeps it optional
  (legacy files stay valid).
- **Fork call**: `POST /apps/fork-pin { slot, props? }` — `props` = the
  wrapper's serializable live props at fork time, stored on the app as the
  dashboard seed. Server dedupes per (subject, slot): an existing app whose
  pins name the slot is returned instead of minting (W0).
- **Data model** (`@vendoai/core`): `AppDocument.placements?: string[]`
  added; `Pin {slot, base}` untouched. Readers classify legacy rows on read:
  a `pins` entry whose `base` matches no captured baseline hash is treated
  as a placement; rows normalize on next write. No migration script.
- **Review state** (rides `inclient.ts`, additive): review-kind remixes are
  apps whose venue requires an approval. New records: rejection note
  `{appId, versionHash, note, by, at}` in a routed collection
  `vendo_remix_rejections`. Wire seam (OSS):
  `GET /apps/review-queue` (host-admin scoped) · existing approval record
  door for approve · `POST /apps/:id/reject-review { note }`.
  Kind (`review` flag) is capture metadata: sync writes `review: true` into
  the baseline file from the wrapper prop.
- **Layering law**: dependency-guard order stays; no new packages.

## Lanes

**W0 (first, alone — everything else rebases on it):** core schema +
placements readers + demo-host pin routes + fork dedupe + orphan deletion.
Packages: core, apps, ui (useSlotApp), examples/*. One PR.

**W1a sync (after W0):** wrapper scan in the sync pipeline
(`packages/actions/src/sync/`), child-import resolution reusing the existing
static capture; loud non-component error; plumbing heuristic (imports of
next/navigation, react context hooks, function-typed props at the call
site) → `review` suggestion; delete registry `remixable:true` handling +
`packages/vendo/src/remixable.ts` + `runtime-capture.ts` and their routes.

**W1b ui (after W0, parallel with W1a):** move the ✦ affordance from
VendoSlot to Remixable; gesture → fork-pin with props snapshot; in-place
jailed mount at the wrapper (reuse JailedComponent + AppFrame); delete chip
plumbing; VendoSlot keeps only app-mounting; ✦ management popover (status /
revert / open panel scoped to the remix).

**W1c lifecycle (after W0, parallel):** review-kind gating in open/venue
logic; last-approved-version rendering (venue verdict picks newest approved
version, not current, for review-kind); rejection notes + panel surfacing;
review-queue wire seam. Forbidden from W1b's files except `use-slot-app.ts`
read (coordinate via driving session if a shared file is unavoidable).

**W1d console (vendo-web repo, after W1c's seam is merged):** the approved
mockup as a real console screen against the seam. Deploy after merge.

**W1e integration (after W1a–W1d):** convert demo-bank + demo-accounting;
ONE continuous browser E2E per checklist. This lane owns redeploying any
demo host it touches.

**W2 eval (after W1e):** frozen protocol runner. Read
`docs/eval/REMIX.md` rules 1–5 verbatim; scenarios run against the wrapper
surface; fails are data; never feed findings back into code this wave.

**W3 housekeeping (parallel with W2):** per checklist. Docs rewrite covers
docs/host-components.md, docs-site connect/cli/reference pages.

**W4 sharing (gated):** starts only after rebuild/cutover lands on main.
Rebase everything first. One rule: `can()`-granting on an app with pins
requires an approval for the CURRENT version; share dialog "needs review
first" state + request-review action. Coordinate with the wave-3
orchestrator before touching their surface.

## Rules for every lane

- Own worktree, own branch off the current base; NEVER two agents in one
  worktree (dist artifacts are shared — proven 2026-08-01).
- Tests written with the code; never edit existing tests to make code pass
  (a legitimately-obsolete test change is stated out loud in the PR).
- Local `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green
  before push; umbrella suite judged un-contended (--concurrency=1 rule).
- PR per lane, auto-merge armed when green; AI-reviewer findings triaged
  and batched into one push.
- UI-touching PRs carry real-browser screenshots.
- Known env gotchas: engine #631 (generation vs Maple catalog) — seed apps
  through the records door where generation blocks a test; `pkill -f "next
  start"` does not kill the next-server child (PGlite lock corruption);
  `next dev` can wedge in worktrees — prefer `next build && next start`.
