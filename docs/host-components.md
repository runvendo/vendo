# Host components and UI surfaces

`@vendoai/ui` is headless by default. It imports shared shapes from
`@vendoai/core` and talks to the server only through the umbrella wire.

## Entry points

| Entry | Contents |
| --- | --- |
| `@vendoai/ui` | client, provider, and hooks, with no styles |
| `@vendoai/ui/chrome` | shipped, theme-driven surfaces |
| `@vendoai/ui/tree` | the `vendo-genui/v1` renderer |
| `@vendoai/ui/voice` | voice stage driver and surface |

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
  propsSchema: StandardSchema;
  remixable?: boolean;
}

export type ComponentCatalog = ReadonlyArray<RegisteredComponent>;
```

Names are PascalCase and unique. `propsSchema` uses the Standard Schema
interface. Set `remixable` only when sync may capture the component's real
source as a pin baseline. A remixable component's module must carry a
**default export** of the component — the jail's and the in-client mount's
module loaders render the captured entry module's default export (a named-only
export captures fine but fails at render with "must have a React default
export"). A remixable registration may also declare a static,
JSON-compatible `sampleProps` object: sync captures it into the baseline and
both venues use it as stubbed data when a fork renders without live props
(the sandboxed jail and, for an approved version, the in-client host-page
mount — promotion never changes what props the component sees). Sync
also follows the component's local imports for two hops and snapshots direct
`.css` imports from canonical app roots (`app/layout.*`, `app/root.*`,
`pages/_app.*`, and `src/` variants) so forks render furnished — with the
host's sub-components and styles — instead of bare React. The prewired
primitives are reserved and do not appear in the catalog: `Stack`, `Row`,
`Grid`, `Text`, `Skeleton`, `Surface`, and `Divider`.

When a component cannot be followed through a static import, use the umbrella
helper with the registration module URL:

```ts
import { remixable } from "@vendoai/vendo/react";

const invoiceCard = remixable({
  name: "InvoiceCard",
  component: InvoiceCard,
  exportable: true,
}, import.meta.url);
```

In development the helper reports the module to the Vendo wire, which captures
the source only when no valid static baseline exists. The capture route is not
mounted in production. `vendo sync` exits non-zero for any unresolved slot; a
slot that is intentionally never capturable can be acknowledged in the
human-owned `.vendo/overrides.json`:

`vendo init` offers remix wrapping: every statically capturable
`{ name, component }` registration that is not yet remixable becomes a
proposed, permission-gated code change inserting `remixable: true` into the
registration literal (router tables with a `path` field are never offered).
Approved wraps are captured by an immediate re-sync so remix works right after
init.

```json
{
  "format": "vendo/overrides@1",
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
| `useVoice` | voice stage state, start, stop, and transcript |
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

`VendoPalette` is an optional extra, not part of the default story. Without an
`onCommand` router its conversation commands open the mounted overlay on their
own; commands that need host routing (open app, show activity) hint in
development until you supply `onCommand`. `ApprovalCard`, `ActivityPanel`,
`AutomationsPanel`, and `NoPolicyNotice` cover trust and operations. Voice is
a mode of the chat, not a separate piece.

Customization is a ladder, not a cliff: theme tokens first, then the small
behavioral props below, then ejecting a surface's presentation source into
your repo (the chrome internals live as small per-piece files under
`chrome/thread/` for exactly this), then raw hooks. There is deliberately no
render-prop API. The one sanctioned component-injection point is the
overlay's `thread` prop: the overlay stays the positioning shell and renders
your (ejected or custom) thread component in place of the built-in
`VendoThread`.

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
prompt into its composer — always the opened overlay's own composer, never
an embedded thread's. The slot remix flag and the palette defaults route
through it; it returns `false` when no overlay is mounted so callers can
fall back.

### Slot placement

A bare `<VendoSlot id="HeroCard">{original}</VendoSlot>` renders the host's
own markup untouched and discovers its own pins: when the user pins a view to
the slot in conversation, it mounts in place (polling `apps.list` under the
hood, so hosts never write that dance). An explicit `appId` or `pin` prop
takes over and stands discovery down; `useSlotApp(slotId)` exposes the same
resolution for hosts that need the id (layout decisions).

Set `remix` to show the hover Remix affordance on the slot's content. It
opens the overlay preloaded with a remix request for the slot's registered
component (`remixPrompt` overrides the default text). The slot id must match
a `remixable` catalog registration so the agent can fork the captured source;
init verifies the flag against registrations, and the slot warns in
development when the name is not registered at all.

## Tree rendering

```ts
export function TreeView(props: {
  tree: Tree;
  components: Record<string, ComponentType>;
  data?: Record<string, Json>;
  onAction(req: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome>;
}): JSX.Element;
```

`TreeView` renders `vendo-genui/v1`. `$path` resolves against app data and
`$state` against the per-user, per-app state singleton. Host components render
by registered name. Generated components always run inside the iframe jail
with `connect-src 'none'`. Pin forks carry their captured furnishing —
sub-component sources, app-root stylesheets, and `sampleProps` stubs — into
the jail as inert data; captured CSS is applied only inside the jailed
document, never in the host page.

Actions leave the renderer through `onAction`, then cross the wire and guard.
Tool names and `fn:` references are opaque to the renderer. Erroring nodes are
contained, dangling children render skeletons, and unknown format tags render a
contained notice.

Approved pins mount through `VendoSlot` with a fallback to the original host
component. HTTP app surfaces render in an iframe; a resuming app shows its
dimmed, non-interactive cover.
