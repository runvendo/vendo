/** VendoProvider + the internal context every hook and surface reads (08 §2). */
import type { VendoTheme } from "@vendoai/core";
import type { ChatTransport, UIMessage } from "ai";
import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import { createVendoClient, type VendoClient } from "./client.js";
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
}

const VendoContext = createContext<VendoContextValue | null>(null);

export function VendoProvider(props: {
  client?: VendoClient;
  components?: Record<string, ComponentType>;
  theme?: Partial<VendoTheme>;
  voice?: { driver: VoiceDriver };
  transport?: ChatTransport<UIMessage>;
  onPin?(app: { appId: string; payload: unknown }): void;
  children: ReactNode;
}): ReactNode {
  const { client, components, theme, voice, transport, onPin, children } = props;
  const value = useMemo<VendoContextValue>(
    () => ({
      client: client ?? createVendoClient({}),
      components: components ?? {},
      theme: resolveTheme(defaultVendoTheme, theme),
      voice,
      transport,
      onPin,
    }),
    [client, components, theme, voice, transport, onPin],
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

/** Like useVendoTheme, but provider-optional: surfaces that also work standalone
    (TreeView) fall back to the default brand tokens. */
export function useVendoThemeOrDefault(): VendoTheme {
  return useContext(VendoContext)?.theme ?? defaultVendoTheme;
}
