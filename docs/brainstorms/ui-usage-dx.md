# Brainstorm: host-developer UI usage DX

Lane of the install-dx-2 coordinator. Brainstormed with Yousef 2026-07-17,
extended 2026-07-18 (discoverability, teams, playground, voice/mobile).
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

### 5. Voice and mobile posture

- **Voice is a mode of the chat** (mic in the composer; stage visuals take
  over the panel while active), not a shelf piece. VendoStage stops being a
  separate concept a host mounts.
- **Mobile-friendliness is a requirement on every shelf piece**, not a
  component: the overlay becomes a full-screen sheet on small screens.
  Yousef's follow-up UI-improvement session should treat mobile as a
  first-class acceptance bar.

### 6. Discoverability (how end users learn the app is moldable)

Three layers; the first two are host-configurable, defaults chosen:

- **Ambient (the launcher pill)** — options: quiet (plain pill) or whisper
  (first visit only: one gentle pulse + a ~6s caption saying the app can be
  reshaped, then never again). The loud-banner option is dead. **Default:
  whisper.**
- **First-open moment** — options: greeting-as-tutorial (the agent's first
  message introduces what it can do with 2–3 tappable prompts seeded from
  the host's real catalog, one always a molding prompt; init generates the
  seeds from extraction, host can override), coach-mark tour, or cold
  composer. **Default: greeting-as-tutorial.**
- **Contextual** (already in the shelf) — slot ghost CTAs, remix hover
  affordance, Trigger buttons. On by default; host controls placement.

Packaging: one host-facing dial (e.g. quiet/default/loud) rather than many
knobs. Hard rule: every discoverability element fires once per user, ever —
nothing nags. Mockups: scratchpad `discoverability-options.html` (session
artifact, regenerate as needed).

### 7. Teams (multiplayer molding)

Grounded in prior locked decisions (Notion cloud-vs-OSS page, app-format
spec, pricing v2) — this section maps already-decided machinery onto
end-user UI; it does not reopen the mechanics. Relevant priors: sharing =
frozen snapshot copies with no updates (Pro tier, user-level); publishing =
org registry with capability-aware updates and admin approval of capability
expansions, and only published items are pinnable; the org overlay is the
versioned deploy unit; all sharing is paid; orgs live on the Vendo-hosted
side; apps always run as the viewer and grants never transfer.

New decisions this session:

- **Vendo manages teams** (not inherited-only from the host), **with import
  from the host's org structure** so nobody rebuilds membership by hand.
  Imported teams should be read-only mirrors (host stays source of truth);
  native Vendo teams are editable.
- **Team management lives in the Cloud console** (admin-facing). No
  in-product team CRUD for orgs. The one end-user-grade entry point is
  **share-by-link** (the copies mechanic — no team required).
- **Page is the single home for all end-user team UI.** No new shelf
  pieces: a "Publish to team" action on a view (shows pending-review until
  an admin approves in the console), a "From your team" shelf on the board
  (registry browse, install with updates, bylines + used-by counts as social
  proof), and share-link redemption landing as "add a copy."
- **The UI must keep the two verbs legible**: "Send a copy" (frozen, no
  updates) vs "Publish to team" (registry, updatable install).
- **No update chips**: registry installs update silently within
  already-approved capabilities (that is what publishing means); the only
  visible state is the rare "paused — awaiting admin review" when an update
  wants new capabilities.
- **Org-blessed defaults are the existing publish → admin pin → org overlay
  path**, surfaced in the console (preview/diff/rollback per the overlay
  design). End-user side needs almost nothing — the component is simply
  different, with a subtle "customized by your org" note for legibility.
- **Precedence: a personal pin beats the org default.** Org defaults
  replace the host's stock baseline, never a user's own molding — the org
  default is what you get until you mold. (Compliance-enforced surfaces are
  governance-rung territory, later.)

Mockups: scratchpad `team-molding-options.html` (session artifact; note its
"team shelf = copies" caption predates the correction above — the shelf is
the registry, installs receive updates).

### 8. Playground

`vendo playground` (named playground, not `vendo dev`): a local page
rendering every shelf piece against the scripted transport (director-mode
machinery) — no model key, no real data — showing all states: streaming,
approval parked, slot empty/filled/broken, activities full. Belongs to
install-dx scope.

## Adjacent bets surfaced (not this lane's scope)

- **Proactive molding** — the agent notices repeated behavior and offers a
  view; proposals appear as quiet chips, never auto-mount. Deferred with
  mold mode.
- **Molding analytics for host PMs** — "what users tried to build / pinned
  / failed at" as a host-facing insights surface. Data mostly exists
  (audit/activity + telemetry); the product surface does not. Cloud
  insights territory.

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
- Teams: exact import mechanics from the host (seam vs directory sync), and
  where the share-link preview renders for a recipient with no Vendo state
  yet.

## Later bucket (explicitly deferred, in one place)

Mold mode (auto-remix any catalog component) · org governance console
depth (review flows beyond the pin/overlay basics; compliance-enforced
surfaces) · proactive molding · host-PM molding analytics.
