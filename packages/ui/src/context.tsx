/** VendoProvider + the internal context every hook and surface reads (08 §2). */
import type { ComponentRegistry, ComponentRegistryEntry, VendoTheme } from "@vendoai/core";
import type { ChatTransport, UIMessage } from "ai";
import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import { createVendoClient, type VendoClient } from "./client.js";
import type { VendoDiscoverability, VendoGreeting } from "./chrome/discoverability.js";
import type { ToolMetaMap } from "./chrome/humanize.js";
import { getKitIntl, setKitIntl, type KitIntl } from "./kit/format.js";
import { defaultVendoTheme, resolveTheme } from "./theme.js";
import type { VoiceDriver } from "./voice/driver.js";

export interface VendoContextValue {
  client: VendoClient;
  /** Host catalog implementations, by registered name (08 §2). */
  components: Record<string, ComponentType>;
  /** Resolved brand tokens (defaults ⊕ provider overrides). */
  theme: VendoTheme;
  /** Optional host-provided voice transport (08 §3). */
  voice?: { driver: VoiceDriver };
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
  onPin?(app: { appId: string; payload: unknown }): void;
  /** Which VendoSlot a pin lands in — the pin ceremony's destination. Only
   *  needed by hosts mounting SEVERAL slots: with one, the ceremony finds it,
   *  and with none there is nothing to fly to. Presentation only; the pin
   *  itself is whatever `onPin` writes. */
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
  /** The host's display currency + locale for every Kit formatter — what a
      generated `format:"money"` column or `<Money cents/>` renders in. */
  intl: KitIntl;
}

/** One connectable toolkit in the connect dock (ENG-225). */
export interface ConnectorOption {
  toolkit: string;
  /** Broker connector id, when the host pins one (04 §3.1). */
  connector?: string;
  /** Display name; defaults to the capitalized toolkit. */
  label?: string;
}

const VendoContext = createContext<VendoContextValue | null>(null);

/** 08 §2 (amended 2026-07-18): the components input — the plain name→component
 * map, or the 01 §14 name-keyed ComponentRegistry (the same object the server
 * takes as `catalog`). */
export type HostComponentsInput = Record<string, ComponentType> | ComponentRegistry;

/** Safe narrow: a plain-map value is a function/class component or an exotic
 * React component object ($$typeof/render/type — never a `component` field),
 * while a registry entry always carries `component` plus its REQUIRED string
 * `description` (01 §14). Both checks together rule out misdetection. */
function isRegistryEntry(value: ComponentType | ComponentRegistryEntry): value is ComponentRegistryEntry {
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
    map[name] = isRegistryEntry(value) ? (value.component as ComponentType) : value;
  }
  return map;
}

export function VendoProvider(props: {
  client?: VendoClient;
  components?: HostComponentsInput;
  theme?: Partial<VendoTheme>;
  voice?: { driver: VoiceDriver };
  transport?: ChatTransport<UIMessage>;
  onPin?(app: { appId: string; payload: unknown }): void;
  /** The slot pins land in — see VendoContextValue.pinSlot. */
  pinSlot?: string;
  tools?: ToolMetaMap;
  connectors?: ConnectorOption[];
  discoverability?: VendoDiscoverability;
  greeting?: VendoGreeting;
  /** Display currency + locale, e.g. `{ currency: "PKR" }` for a Pakistani
      host. Omitted fields fall back to USD / en-US. */
  intl?: Partial<KitIntl>;
  children: ReactNode;
}): ReactNode {
  const { client, components, theme, voice, transport, onPin, pinSlot, tools, connectors, discoverability, greeting, intl, children } = props;
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
      client: client ?? createVendoClient({}),
      components: hostComponentMap(components),
      theme: resolveTheme(defaultVendoTheme, theme),
      voice,
      transport,
      onPin,
      pinSlot,
      tools: tools ?? {},
      connectors: connectors ?? "auto",
      discoverability: discoverability ?? "default",
      greeting,
      intl: resolvedIntl,
    }),
    [client, components, theme, voice, transport, onPin, pinSlot, tools, connectors, discoverability, greeting, resolvedIntl],
  );
  return <VendoContext.Provider value={value}>{children}</VendoContext.Provider>;
}

export function useVendoContext(): VendoContextValue {
  const ctx = useContext(VendoContext);
  if (!ctx) throw new Error("Vendo hooks and surfaces must be rendered inside <VendoProvider>.");
  return ctx;
}

/** Resolved brand tokens (08 §3 — the useVendoTheme hook). */
export function useVendoTheme(): VendoTheme {
  return useVendoContext().theme;
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
