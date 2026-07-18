# Brainstorm: host-developer UI usage DX

Lane of the install-dx-2 coordinator. Brainstormed with Yousef 2026-07-17.
**Status: CONVERGED.** Decisions below are his calls; open questions are for
the coordinator to route.

## Goal

Make the client-side integration radically simple while serving the vision:
Vendo is the agentic interface that lets end users mold the host's app and
make its UI their own. The current surface (4 chrome components + escape
hatches + hand-wired glue in both demos) was judged "really bad" and
re-derived from first principles.

## Decisions

### 1. The default is one thing: a chat popover

- The Overlay is **just a chat** — as originally designed. No management
  views, no command routing, no palette inside it.
- Launcher pill is configurable on/off; hosts with their own button turn it
  off and open the overlay programmatically.
- No generated glue file, no auto-mounted extras. Install = wrap the app in
  the root provider, mount the overlay, done.

### 2. Everything else is a shelf of placeable pieces

Six components, each describable in one sentence, each a one-liner to place:

| Piece | One sentence |
| --- | --- |
| **Overlay** | The chat, floating over the app (the default surface). |
| **Thread** | The same chat, embedded in a host page (assistant tab). |
| **Page** | The full workspace console (threads, apps, automations, accounts, activity). |
| **Slot** | A region of the host page the user can replace with their own generated view. |
| **Activities** | Drop-in feed of what the agent did + pending approvals, placeable in any host page. |
| **Trigger** | A button that opens the chat preloaded with a prompt and context. |

- **Palette is demoted** to an optional extra, out of the default story.
  (Finding: today it is not self-sufficient — with no host-written command
  router it does nothing. Fix or leave demoted; open question.)
- **Activities is new**: it replaces what Maple hand-rolled (hook + shipped
  card + polling). Leaning one combined feed with approvals as the
  actionable items on top, rather than separate approvals/activity pieces.
- **Trigger is new**: it generalizes what Cadence hand-rolled for its remix
  button (custom events, canned prompts). Every "do it with AI" button in a
  host product is this piece.
- **Remix folds into Slot as a flag**, not a seventh component: a remixable
  slot shows the hover affordance, opens the chat pointed at the captured
  component, and the result pins back into the same slot. All of Cadence's
  hand-wiring becomes one prop. Init should verify slot flags agree with
  catalog `remixable` registrations.

### 3. Rejected / deferred

- **Board (open canvas users fill with views): rejected.** The collection of
  a user's created views already has a home — Page's apps area. Instead,
  Page's apps view should *feel* like a board: a grid of live views to open,
  rearrange, remix — not an admin list. UX note for Page, not new API.
- **Mold mode (global customize toggle: every catalog-registered component
  gets the remix affordance automatically, no slot-wrapping): deferred.**
  Biggest bet in the lane; revisit after the shelf ships.
- **A parts/render-prop API on chrome (`renderMessage`, header/composer
  slots): rejected.** See the ladder below.

### 4. The customization ladder (resolves the Tier 1 → 2 cliff)

The coordinator's key finding was the cliff: the moment shipped chrome isn't
quite right, the developer falls from one component to composing eight hooks
(the shipped thread is ~1,100 lines over a ~200-line hook). Resolution —
four rungs, no cliff between them:

1. **Theme tokens** — brand via the existing token pipeline; most hosts stop
   here.
2. **Props** — small, behavioral, placement-level options only (launcher
   on/off, remix flag, trigger prompt). Deliberately no render-prop API.
3. **Eject** — shadcn-style: a CLI command copies a surface's presentation
   source into the host repo as small, well-factored files the developer
   owns and edits directly. Data/wire logic stays in the package (hooks
   remain the dependency), so protocol updates keep flowing; only pixels are
   forked. Per-surface granularity. Doctor should flag ejected code that
   predates new wire part types; a diff mode shows what shipped chrome
   changed since ejection.
4. **Raw hooks** — full custom, unchanged.

Why eject over a parts API: a parts system always misses the slot the host
actually needs and freezes render contracts forever; eject reaches every
pixel on day one, adds zero API surface, and keeps the shipped kit sealed
and simple. Accepted cost: ejected code doesn't auto-upgrade visually.

Consequence: chrome internals must be refactored into small per-piece files
so ejection lands as a tidy directory, not one huge file. The overlay/thread
seam is the one allowed component-injection point (the overlay is a
positioning shell; an ejected thread should be pluggable into it).

## Findings along the way

- Neither demo uses the thread hook raw — only shipped chrome does. The
  cliff is real enough that even our own demos never jumped it.
- Hand-rolled host boilerplate inventory (all should die under the new
  shelf): Maple's approvals inbox (→ Activities), Maple's overlay/palette
  glue layer (→ default overlay + demoted palette), Cadence's remix button
  and event wiring (→ Trigger / Slot remix flag), Cadence's poll-for-pinned-
  app dance around Slot (→ Slot should discover its own pins).

## Open questions

- Activities scope: one combined feed (lean) vs separate approvals inbox and
  activity log.
- Palette: give it self-sufficient default behavior, or keep it a
  host-routed optional extra.
- While-away signal on the default surface: badge on the launcher pill when
  something needs the user? (Raised, not decided.)
- Theming depth: are tokens + theme extraction sufficient beyond brand
  basics? (Lane question, not explored this session.)
- Slot pin discovery: confirm Slot subscribes to its own pins so hosts never
  write the polling dance.
- Migration: how the current chrome exports and both demos move to the
  six-piece shelf, and what `vendo init` scaffolds now that no glue file is
  needed.
