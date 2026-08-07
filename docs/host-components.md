# Host components and UI surfaces

`@vendoai/ui` is headless by default. It imports shared shapes from
`@vendoai/core` and talks to the server only through the umbrella wire.

## Entry points

| Entry | Contents |
| --- | --- |
| `@vendoai/ui` | client, provider, and hooks, with no styles |
| `@vendoai/ui/chrome` | shipped, theme-driven surfaces |
| `@vendoai/ui/tree` | the `vendo-genui/v2` renderer |

## Provider

```ts
export function createVendoClient(config: { baseUrl?: string; headers?: Record<string, string> }): VendoClient;

export function VendoProvider(props: {
  client?: VendoClient;
  components?: Record<string, ComponentType>;
  theme?: Partial<VendoTheme>;
  children: ReactNode;
}): JSX.Element;
```

The default client base is `/api/vendo`. Component names must match the catalog
descriptors extracted by sync.

## Component catalog

```ts
export interface RegisteredComponent {
  name: string;
  description: string;
  propsSchema?: StandardSchema;
  examples?: string[];
}

export type ComponentCatalog = ReadonlyArray<RegisteredComponent>;
```

Names are PascalCase and unique. `propsSchema` uses the Standard Schema
interface. The built-in Kit component names are reserved and do not appear in
the catalog — `Stack`, `Row`, `Grid`, `Surface`, `Card`, `Divider`, `Text`,
`DataTable`, `Stat`, `Button`, `Tabs`, and the rest of the Kit. Read the live
list from `KIT_COMPONENT_NAMES` rather than copying it; there is one component
family, so anything the Kit declares is reserved.

Remix is not a catalog concern: wrapping a component in `<Remixable>` is the
whole registration (see "Remixable surfaces" below). `vendo sync` scans for
the wrappers and captures each wrapped component into
`.vendo/remixable/<slot>.json` — its source, local imports for two hops, and
direct `.css` imports from canonical app roots (`app/layout.*`, `app/root.*`,
`pages/_app.*`, and `src/` variants) — so forks render furnished, with the
host's sub-components and styles, instead of bare React. The slot is the
component's own exported identifier. A wrapper sync cannot capture (inline
JSX, a child that is not statically imported, an anonymous default export)
fails the run loudly with a file:line error; a component that is
intentionally never capturable is acknowledged in the human-owned
`.vendo/overrides.json`, and baselines no wrapper names anymore are pruned on
the next clean sync:

```json
{
  "format": "vendo/overrides@3",
  "tools": {},
  "remix": { "ignoreSlots": ["ThirdPartyWidget"] }
}
```

## Headless hooks

| Hook | Surface |
| --- | --- |
| `useVendoThread` | messages, sending, in-turn approvals, and stop |
| `useApprovals` | pending approvals and batch decisions |
| `useGrants` | grants and revocation |
| `useApps` | list, create, remove, and fork |
| `useApp` | open, call, edit, history, undo, and refresh by re-opening |
| `useSlotApp` | the app currently pinned to a slot (polls; `VendoSlot` uses it itself) |
| `useAutomations` | enable, disable, runs, dry-run, and stop |
| `useActivity` | self-scoped audit activity |
| `useVendoOverlay` | programmatic open/close controller for `VendoOverlay` |
| `useVendoStatus` | connection and guard posture |
| `useVendoTheme` | resolved theme tokens |

All hooks are transport-only and SSR-safe.

## Shipped chrome: the shelf

The default install is one thing: mount `<VendoOverlay />` and you have the
chat, floating over the app. Everything else is a shelf of placeable pieces,
each a one-liner:

| Piece | One sentence |
| --- | --- |
| `VendoOverlay` | The chat, floating over the app (the default surface). |
| `VendoThread` | The same chat, embedded in a host page. |
| `VendoPage` | The full workspace console (threads, apps, automations, activity). |
| `VendoSlot` | A region of the host page the user can replace with their own generated view. |
| `VendoActivities` | Drop-in feed of what the agent did + pending approvals, placeable in any host page. |
| `VendoTrigger` | A button that opens the chat preloaded with a prompt and context. |
| `Remixable` | Marks a host component forkable: a quiet ✦ that blooms on hover into a Remix pill; the fork renders in place. |

`VendoPalette` is an optional extra, not part of the default story. Without an
`onCommand` router its conversation commands open the mounted overlay on their
own; commands that need host routing (open app, show activity) hint in
development until you supply `onCommand`. `ApprovalCard`, `ActivityPanel`,
`AutomationsPanel`, and `NoPolicyNotice` cover trust and operations.

Customization is a ladder, not a cliff — four rungs, no cliff between them:

1. **Theme tokens** — brand via `VendoTheme`; most hosts stop here.
2. **Props** — the small behavioral options on each piece (launcher
   placement, `Remixable`'s `review` flag, trigger prompt). Deliberately no
   render-prop API.
3. **Eject** — `npx vendo eject <surface>` copies a surface's presentation
   source into your repo as files you own. See below.
4. **Raw hooks** — full custom UI on the headless hooks.

### Ejecting a surface

`npx vendo eject --list` shows the ejectable surfaces (`thread`,
`activities`). `npx vendo eject thread` copies the shipped thread's per-piece
sources into `components/vendo/thread/` (under `src/` when your app lives
there) and prints the two-line swap:

```tsx
import { VendoThread } from "./components/vendo/thread";
<VendoOverlay thread={VendoThread} />
```

The copy is presentation only: its imports are rewritten to keep resolving
data and wire logic from `@vendoai/ui`, so protocol updates keep flowing —
only the pixels are forked. A `.vendo-eject.json` manifest in the ejected
directory records the surface and package version; `vendo doctor` warns
(never fails) when the installed `@vendoai/ui` moves past it, pointing at the
changelog. `vendo eject <surface> --force` re-copies the current presentation
over your edits; without `--force` an existing directory is never touched.

The one sanctioned component-injection point is the overlay's `thread` prop:
the overlay stays the positioning shell and renders your (ejected or custom)
thread component in place of the built-in `VendoThread`.

Two shelf pieces are placeable anywhere in host pages:

- **`VendoActivities`** — drop-in feed of what the agent did plus pending
  approvals, placeable in any host page. Pending approvals render on top as
  actionable `ApprovalCard`s (polled, so approvals raised elsewhere appear on
  their own); recent activity renders humanized below. Props: `pollMs`
  (default 5000, `0` disables) and `maxItems` (default 8). Shows a quiet
  one-line empty state when nothing has happened yet.
- **`VendoTrigger`** — a button that opens the chat preloaded with a prompt
  and context. Props: `prompt` (required), `context` (appended to the prompt),
  children as the label. The prompt is prefilled into the composer, never
  auto-sent (the trigger never passes `send`). Hosts using their own element
  call `openVendoConversation({ prompt })` from it directly — the same
  registry seam described under "Overlay entry" below.

### Remixable surfaces

Wrap a component the user should be able to reshape — the wrapper is the
whole registration; `vendo sync` finds it and captures the baseline:

```tsx
import { Remixable } from "@vendoai/ui/chrome";

<Remixable>
  <RentRollTable units={units} />
</Remixable>
```

At rest a small muted ✦ sits in the element's top-right corner. Hovering (or
tabbing into) the element blooms it in place into a **✦ Remix** pill, held
open for a grace period so the cursor can travel to it. Clicking executes the
deterministic fork through the wire (`POST /apps/fork-pin`, engine-copied
from the captured baseline, no model call; the server dedupes per user and
slot) and the fork mounts **in place of the wrapped child**, jailed, for that
user only. The wrapper's JSON-serializable live props flow into the fork on
every render; function props never cross the frame boundary. On a remixed
surface the pill opens the management popover (status, open in panel, revert)
instead. Under `prefers-reduced-motion` the bloom snaps.

The one prop is `review`: a review-kind component's remix stays invisible to
its owner until a host reviewer approves the ship-diff, then renders in place
natively; an instant-kind (default) remix renders immediately and stays
sandboxed forever. The wrapped child must be a single, statically importable
component — inline JSX is a loud sync-time error, and at runtime such a
wrapper simply renders its children with no affordance.

Chrome derives all styling from `VendoTheme` tokens. The required bar is WCAG
2.1 AA, complete keyboard access, screen-reader testing, and mobile web.
Every piece is mobile-friendly by requirement; the overlay becomes a
full-screen sheet below 768px.

### Overlay entry

`<VendoOverlay />` ships a fixed, brand-styled launcher pill in the
bottom-right corner by default. `launcher="bottom-left"` moves it;
`launcher="none"` removes it for hosts that trigger the overlay themselves.
Open state is uncontrolled by default (`defaultOpen`), or controlled via
`open` + `onOpenChange`. `useVendoOverlay()` returns
`{ isOpen, open, close, toggle, newConversation, overlayProps }` — spread
`overlayProps` onto the component and call `toggle()` from your own shortcut
or nav button.

While open, the panel is portaled to `document.body` (so host `transform`/
`filter`/`overflow` styles cannot trap it), body scroll is locked, and the
page behind the scrim is `inert`. Focus lands in the composer on open and
returns to the invoking element on close.

Closing the overlay (scrim click, Escape, close button, or programmatic)
hides it without discarding the conversation: reopening within the page
session shows the same thread. A new-conversation button in the panel header
starts a fresh thread; `newConversation()` on the hook does the same, and
hosts managing their own state can bump the `conversationKey` prop.

Any affordance can open the mounted overlay without a ref through the
registry: `openVendoConversation({ prompt, send, newConversation })` opens
the most recently mounted overlay, optionally preloading (and sending) a
prompt into its composer — always the opened overlay's own composer, never an
embedded thread's. `Remixable`'s "Open in panel" and the palette defaults
route through it; it returns `false` when no overlay is mounted so callers
can fall back.

### Discoverability

Two elements teach end users the app is moldable, both on by default and both
hard-capped at one showing per user per deployment, ever (a persistent flag;
environments where storage is unavailable never show them):

- **Whisper** — the first time the user actually faces a visible launcher
  pill, it pulses once and a small ~6s caption says the app can be reshaped.
  Under `prefers-reduced-motion` the caption shows without the pulse.
  Ineligible states never consume the showing: `launcher="none"` hosts simply
  never see it (no orphan caption), and mounting with the overlay already
  open waits for the close — the one showing only burns when it is genuinely
  visible.
- **Greeting-as-tutorial** — the first-ever fresh conversation opens with an
  agent-voiced intro plus 2–3 tappable starter prompts. Chips prefill the
  composer (never auto-send), and the greeting is presentation-only: it is
  never persisted to the thread and never sent to the model. Threads opened
  with history are ineligible and do not consume the one showing.

One dial controls both, on the provider or per-overlay (the overlay prop
wins): `discoverability="default" | "quiet"`. Quiet disables both without
consuming the one-time showing. Contextual affordances (slot ghosts, remix
hover, Trigger buttons) are host-placed and unaffected by the dial.

Greeting content is host-supplied via the `greeting` prop on
`VendoProvider` or `VendoOverlay`; without it a generic capable
intro (with one molding prompt) is used. The conventional home for the
content is `.vendo/greeting.json`, imported and passed through:

```jsonc
// .vendo/greeting.json
{
  "intro": "Hi — I'm Maple's built-in assistant. …",
  "prompts": [
    "Where did my money go last month?",
    "Build me a spending board for this quarter",
    "Reshape my dashboard around upcoming bills"   // keep one molding prompt
  ]
}
```

```tsx
import greeting from "../.vendo/greeting.json";

<VendoProvider greeting={greeting}>…</VendoProvider>
```

### Slot placement

A bare `<VendoSlot id="HeroCard">{original}</VendoSlot>` renders the host's
own markup untouched and discovers its own pins: when the user pins a view to
the slot in conversation, it mounts in place (polling `apps.list` under the
hood, so hosts never write that dance). An explicit `appId` or `pin` prop
takes over and stands discovery down; `useSlotApp(slotId)` exposes the same
resolution for hosts that need the id (layout decisions).

`VendoSlot` has no remix affordance: remix lives entirely on `<Remixable>`,
which forks the component it wraps in place. A slot's one job is mounting
brand-new generated apps.

## Tree rendering

```ts
export function TreeView(props: {
  tree: Tree;
  components: Record<string, ComponentType>;
  data?: Record<string, Json>;
  onAction(req: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome>;
}): JSX.Element;
```

`PayloadView` renders `vendo-genui/v2` (`TreeView` is the underlying walk). `$path` resolves against app data and
`$state` against the per-user, per-app state singleton. Host components render
by registered name. Generated components always run inside the iframe jail
with `connect-src 'none'`. Pin forks carry their captured furnishing —
sub-component sources and app-root stylesheets — into the jail as inert
data; captured CSS is applied only inside the jailed document, never in the
host page.

Actions leave the renderer through `onAction`, then cross the wire and guard.
Tool names and `fn:` references are opaque to the renderer. Erroring nodes are
contained, dangling children render skeletons, and unknown format tags render a
contained notice.

Approved pins mount through `VendoSlot` with a fallback to the original host
component. HTTP app surfaces render in an iframe; a resuming app shows its
dimmed, non-interactive cover.
