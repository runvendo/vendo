/** VendoProvider + the internal context every hook and surface reads (08 §2). */
import type { VendoTheme } from "@vendoai/core";
import type { ChatTransport, UIMessage } from "ai";
import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import { createVendoClient, type VendoClient } from "./client.js";
import type { ToolMetaMap } from "./chrome/humanize.js";
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
  /** Optional host-supplied friendly tool metadata, keyed by tool name/id
      (ENG-216 humanization seam — additive, UI-side, no wire/contract change). */
  tools: ToolMetaMap;
}

const VendoContext = createContext<VendoContextValue | null>(null);

export function VendoProvider(props: {
  client?: VendoClient;
  components?: Record<string, ComponentType>;
  theme?: Partial<VendoTheme>;
  voice?: { driver: VoiceDriver };
  transport?: ChatTransport<UIMessage>;
  onPin?(app: { appId: string; payload: unknown }): void;
  tools?: ToolMetaMap;
  children: ReactNode;
}): ReactNode {
  const { client, components, theme, voice, transport, onPin, tools, children } = props;
  const value = useMemo<VendoContextValue>(
    () => ({
      client: client ?? createVendoClient({}),
      components: components ?? {},
      theme: resolveTheme(defaultVendoTheme, theme),
      voice,
      transport,
      onPin,
      tools: tools ?? {},
    }),
    [client, components, theme, voice, transport, onPin, tools],
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
