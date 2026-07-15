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
source as a pin baseline. A remixable registration may also declare a static,
JSON-compatible `sampleProps` object: sync captures it into the baseline and
the jail uses it as stubbed data when a fork renders without live props. Sync
also follows the component's local imports for two hops and snapshots direct
`.css` imports from canonical app roots (`app/layout.*`, `app/root.*`,
`pages/_app.*`, and `src/` variants) so forks render furnished — with the
host's sub-components and styles — instead of bare React. The prewired
primitives are reserved and do not appear in the catalog: `Stack`, `Row`,
`Grid`, `Text`, `Skeleton`, `Surface`, and `Divider`.

## Headless hooks

| Hook | Surface |
| --- | --- |
| `useVendoThread` | messages, sending, in-turn approvals, and stop |
| `useApprovals` | pending approvals and batch decisions |
| `useGrants` | grants and revocation |
| `useApps` | list, create, remove, and fork |
| `useApp` | open, call, edit, history, undo, and refresh by re-opening |
| `useAutomations` | enable, disable, runs, dry-run, and stop |
| `useActivity` | self-scoped audit activity |
| `useVendoOverlay` | programmatic open/close controller for `VendoOverlay` |
| `useVendoStatus` | connection and guard posture |
| `useVoice` | voice stage state, start, stop, and transcript |
| `useVendoTheme` | resolved theme tokens |

All hooks are transport-only and SSR-safe.

## Shipped chrome

`VendoThread`, `VendoOverlay`, `VendoSlot`, `VendoPage`, `VendoPalette`, and
`VendoStage` cover the main placements. `ApprovalCard`, `ActivityPanel`,
`AutomationsPanel`, and `NoPolicyNotice` cover trust and operations.

Chrome derives all styling from `VendoTheme` tokens. The required bar is WCAG
2.1 AA, complete keyboard access, screen-reader testing, and mobile web.

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
