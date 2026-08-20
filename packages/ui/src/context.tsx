/** VendoProvider + the internal context every hook and surface reads (08 §2). */
import type {
  ComponentRegistryEntry,
  VendoNavigation,
  VendoRouteMap,
  VendoTheme,
} from "@vendoai/apps/contract";
import type { ChatTransport, UIMessage } from "ai";
import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import { createVendoClient, type VendoClient } from "./client.js";
import type { VendoDiscoverability, VendoGreeting } from "./chrome/discoverability.js";
import type { ToolMetaMap } from "./chrome/humanize.js";
import { getKitIntl, setKitIntl, type KitIntl } from "./kit/format.js";
import { defaultVendoTheme, resolveTheme } from "./theme.js";

export interface VendoContextValue {
  client: VendoClient;
  /** Host catalog implementations, by registered name (08 §2). */
  components: Record<string, ComponentType>;
  /** The slots `vendo sync` could split — the generated wiring's own keys, and
      exactly the components a ✦ may appear on. Empty when the host wired no
      wiring: nothing has ported, so nothing offers a remix. */
  remixSlots: ReadonlySet<string>;
  /** Resolved brand tokens (defaults ⊕ provider overrides). */
  theme: VendoTheme;
  /** The host's `.vendo/fonts.css` text — the brand's `@font-face` rules, as
      inlined data URIs. Chrome injects it beside its own sheet. */
  fonts?: string;
  /**
   * Optional chat-transport override (director/replay tooling). When absent,
   * threads use the live wire transport — this is never a default.
   */
  transport?: ChatTransport<UIMessage>;
  /**
   * Optional host handler for pinning a previewed app into the product. When
   * present, generated views show a "Pin to dashboard" action; nothing is
   * saved to the host surface until the user invokes it.
   */
  onPin?(app: { appId: string; payload: unknown }): void | Promise<void>;
  /** Which VendoSlot a pin lands in. Set it and a pin becomes REAL: the pin
   *  action places the app in this slot through the wire (`apps.place`) and
   *  the slot picks it up on its own — a host needs no pin route of its own.
   *  Unset, a pin is presentation plus whatever `onPin` chooses to do. */
  pinSlot?: string;
  /** Optional host-supplied friendly tool metadata, keyed by tool name/id
      (ENG-216 humanization seam — additive, UI-side, no wire/contract change). */
  tools: ToolMetaMap;
  /** ENG-225 — the connect dock's catalog: which toolkits this host's users
      can connect. An explicit array is used as-is (empty = no dock renders);
      `"auto"` (the omitted-prop default) means surfaces resolve the catalog
      from `GET /connections/catalog` — everything the host's server-side
      connectors advertise. Resolve through useConnectorCatalog, never read
      this raw. */
  connectors: ConnectorOption[] | "auto";
  /** The discoverability dial (ui-usage-dx §6): quiet | default. Default keeps
      the fire-once whisper + greeting; surfaces may override via their own prop. */
  discoverability: VendoDiscoverability;
  /** Host greeting-as-tutorial content (§6): intro + starter prompts, the
      `.vendo/greeting.json` shape. Absent = the built-in generic greeting. */
  greeting?: VendoGreeting;
  /** The host's display currency + locale for the formatting the KIT still does
      itself — a chart's axis ticks, and the chrome's own rendering of a tool's
      arguments. A screen formats its own figures with `Intl`, so the currency
      also reaches the model through its briefing. */
  intl: KitIntl;
  /** Spec 2026-08-05 §2 — whether sends snapshot the visible host page into
      the [Situation] channel. Default true; false disables capture entirely
      (useVendoContext data still rides). */
  captureScreen: boolean;
  /** The host's own pages, by the name a generated `<Link to>` may reach for.
      Unset, no target resolves and no link navigates. */
  routes?: VendoRouteMap;
  /** Where a Link press goes. The HOST performs the move — only its router
      knows its basePath and its transitions; Vendo only says where. */
  onNavigate?(nav: VendoNavigation): void;
}

/** One connectable toolkit in the connect dock (ENG-225). */
export interface ConnectorOption {
  toolkit: string;
  /** Broker connector id, when the host pins one (04 §3.1). */
  connector?: string;
  /** Display name; defaults to the capitalized toolkit. */
  label?: string;
}

/** Exported for the provider-optional hooks that live in their own modules
 *  (`./routes.js`); not part of the package's public surface. */
export const VendoContext = createContext<VendoContextValue | null>(null);

/** 08 §2 (amended 2026-07-18): the components input — the plain name→component
 * map, or the 01 §14 name-keyed ComponentRegistry (the same object the server
 * takes as `catalog`). The choice is per ENTRY, which is how hostComponentMap
 * has always read it; a union of the two whole-map forms could not express a
 * mixed one. `ComponentType<never>` because a host component declares its own
 * required props and `ComponentType`'s default `{}` rejects every one of them. */
export type HostComponentsInput = Record<string, ComponentType<never> | ComponentRegistryEntry>;

/** Safe narrow: a plain-map value is a function/class component or an exotic
 * React component object ($$typeof/render/type — never a `component` field),
 * while a registry entry always carries `component` plus its REQUIRED string
 * `description` (01 §14). Both checks together rule out misdetection. */
function isRegistryEntry(value: ComponentType<never> | ComponentRegistryEntry): value is ComponentRegistryEntry {
  return typeof value === "object" && value !== null
    && "component" in value
    && typeof (value as ComponentRegistryEntry).description === "string";
}

/** Extract the name→component map from either components-input form. Registry
 * data fields (description, props schema, examples) are server-side
 * concerns the client ignores (01 §14). */
export function hostComponentMap(components: HostComponentsInput | undefined): Record<string, ComponentType> {
  if (components === undefined) return {};
  const map: Record<string, ComponentType> = {};
  for (const [name, value] of Object.entries(components)) {
    map[name] = (isRegistryEntry(value) ? value.component : value) as ComponentType;
  }
  return map;
}

/** The client half of the generated remix wiring (`vendo sync` writes
 * `.vendo/generated/remix-wiring.ts`; `holes` binds a name the ported screen
 * renders to the component itself, and the wiring's KEYS are the slots sync
 * could split). Read STRUCTURALLY, so the host hands the whole generated const
 * over — `tools` and all — exactly as it hands it to
 * `createVendo({ remixWiring })`. */
export type RemixWiringInput = Record<string, {
  tools?: Record<string, unknown>;
  holes?: Record<string, ComponentType<never>>;
}>;

/** Every slot's holes, folded name-keyed — a component name is global here, so
 * two slots rendering the same hole are one entry rather than a collision. */
function remixHoles(wiring: RemixWiringInput | undefined): Record<string, ComponentType> {
  return Object.fromEntries(
    Object.values(wiring ?? {}).flatMap((slot) => Object.entries(slot.holes ?? {})),
  ) as Record<string, ComponentType>;
}

export function VendoProvider(props: {
  client?: VendoClient;
  /** The wire mount, path prefix included ("/maple/api/vendo"). Default
      "/api/vendo". Ignored when `client` is passed — an explicit client already
      carries its own base. */
  baseUrl?: string;
  components?: HostComponentsInput;
  /** The same generated const `createVendo({ remixWiring })` takes. It is read
      two ways, and both ends need it.

      Its HOLES join the components map as its WEAKEST leg — mirroring the
      server, where a hole is the weakest leg of the catalog (`vendo`
      compose-surfaces.ts) — so a `components` entry for the same name still
      wins. The client screen VM's vocabulary is built from this map too
      (tree/renderer.tsx), so a hole missing here is a name the port cannot even
      paint.

      Its KEYS name the slots sync could split, and `<Remixable>` offers the ✦
      on those and only those — sync already refused the rest, loudly, in its
      report. Unset is the honest zero: no slot has ported, so no component
      offers a remix, and none paints a hole. */
  remixWiring?: RemixWiringInput;
  theme?: Partial<VendoTheme>;
  /** The host's `.vendo/fonts.css` text — see VendoContextValue.fonts. */
  fonts?: string;
  transport?: ChatTransport<UIMessage>;
  onPin?(app: { appId: string; payload: unknown }): void | Promise<void>;
  /** The slot pins land in — see VendoContextValue.pinSlot. */
  pinSlot?: string;
  tools?: ToolMetaMap;
  connectors?: ConnectorOption[];
  discoverability?: VendoDiscoverability;
  greeting?: VendoGreeting;
  /** Display currency + locale, e.g. `{ currency: "PKR" }` for a Pakistani
      host. Omitted fields fall back to USD / en-US. */
  intl?: Partial<KitIntl>;
  /** Disable the automatic screen snapshot on send (spec 2026-08-05 §2). */
  captureScreen?: boolean;
  /** The host's own pages a generated `<Link to>` may open — see
      VendoContextValue.routes. */
  routes?: VendoRouteMap;
  /** Perform the navigation a Link press asked for (`router.push(nav.path)`). */
  onNavigate?(nav: VendoNavigation): void;
  children: ReactNode;
}): ReactNode {
  const { client, baseUrl, components, remixWiring, theme, fonts, transport, onPin, pinSlot, tools, connectors, discoverability, greeting, intl, captureScreen, routes, onNavigate, children } = props;
  const currency = intl?.currency;
  const locale = intl?.locale;
  // Installed during RENDER, not in an effect: the formatters are called while
  // children render (and on the server, where effects never run), so an effect
  // would paint one pass of "$" before correcting itself.
  const resolvedIntl = useMemo(() => {
    setKitIntl({ ...(currency === undefined ? {} : { currency }), ...(locale === undefined ? {} : { locale }) });
    return getKitIntl();
  }, [currency, locale]);
  const value = useMemo<VendoContextValue>(
    () => ({
      client: client ?? createVendoClient(baseUrl === undefined ? {} : { baseUrl }),
      components: { ...remixHoles(remixWiring), ...hostComponentMap(components) },
      remixSlots: new Set(Object.keys(remixWiring ?? {})),
      theme: resolveTheme(defaultVendoTheme, theme),
      fonts,
      transport,
      onPin,
      pinSlot,
      tools: tools ?? {},
      connectors: connectors ?? "auto",
      discoverability: discoverability ?? "default",
      greeting,
      intl: resolvedIntl,
      captureScreen: captureScreen ?? true,
      routes,
      onNavigate,
    }),
    [client, baseUrl, components, remixWiring, theme, fonts, transport, onPin, pinSlot, tools, connectors, discoverability, greeting, resolvedIntl, captureScreen, routes, onNavigate],
  );
  return <VendoContext.Provider value={value}>{children}</VendoContext.Provider>;
}

/** Everything VendoProvider supplies — the seam every hook and surface reads.
 *  Named `useVendoProvider` (not `useVendoContext`) since 2026-08-05: the
 *  host-facing `useVendoContext(data)` publishes into the agent's [Situation]
 *  channel and owns that name. */
export function useVendoProvider(): VendoContextValue {
  const ctx = useContext(VendoContext);
  if (!ctx) throw new Error("Vendo hooks and surfaces must be rendered inside <VendoProvider>.");
  return ctx;
}

/** Resolved brand tokens (08 §3 — the useVendoTheme hook). */
export function useVendoTheme(): VendoTheme {
  return useVendoProvider().theme;
}

/** Host-supplied tool metadata (ENG-216). Provider-optional so surfaces that
    can render standalone still degrade to the pure formatting fallback. */
export function useVendoTools(): ToolMetaMap {
  return useContext(VendoContext)?.tools ?? {};
}

/** Like useVendoTheme, but provider-optional: surfaces that also work standalone
    (TreeView) fall back to the default brand tokens. */
export function useVendoThemeOrDefault(): VendoTheme {
  return useContext(VendoContext)?.theme ?? defaultVendoTheme;
}

/** The wire, provider-optional. A tree inside a provider can ask what became of
    an approval one of its presses parked; a standalone one has nobody to ask and
    simply never resolves one. */
export function useVendoClientOrNone(): VendoClient | undefined {
  return useContext(VendoContext)?.client;
}

/** The discoverability dial, provider-optional (standalone surfaces default on). */
export function useVendoDiscoverability(): VendoDiscoverability {
  return useContext(VendoContext)?.discoverability ?? "default";
}

/** Host greeting-as-tutorial content, provider-optional (absent = built-in). */
export function useVendoGreeting(): VendoGreeting | undefined {
  return useContext(VendoContext)?.greeting;
}

/** Display currency + locale, provider-optional (standalone surfaces get the
    ambient defaults, which are USD/en-US until a provider sets them). */
export function useVendoIntl(): KitIntl {
  return useContext(VendoContext)?.intl ?? getKitIntl();
}
