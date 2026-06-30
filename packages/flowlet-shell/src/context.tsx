import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import type { UINode } from "@flowlet/core";
import { StubRenderer } from "@flowlet/react";
import { themeToStyle, type FlowletTheme } from "./theme";
import { createLocalStore, type FlowletStore } from "./seams/store";
import { createLocalIntegrations, type FlowletIntegrations } from "./seams/integrations";
import "./styles.css";

export type RenderNode = (node: UINode) => ReactNode;

export interface ShellContextValue {
  store: FlowletStore;
  integrations: FlowletIntegrations;
  renderNode: RenderNode;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export interface FlowletShellProviderProps {
  store?: FlowletStore;
  integrations?: FlowletIntegrations;
  /** Override the render surface. Default delegates to F1's StubRenderer. */
  renderNode?: RenderNode;
  /** Component impls for the default StubRenderer-backed renderNode. */
  impls?: Record<string, ComponentType<Record<string, unknown>>>;
  theme?: FlowletTheme;
  children: ReactNode;
}

export function FlowletShellProvider({
  store, integrations, renderNode, impls, theme, children,
}: FlowletShellProviderProps) {
  const value = useMemo<ShellContextValue>(() => ({
    store: store ?? createLocalStore(),
    integrations: integrations ?? createLocalIntegrations([]),
    renderNode: renderNode ?? ((node) => <StubRenderer node={node} impls={impls ?? {}} />),
  }), [store, integrations, renderNode, impls]);

  return (
    <ShellContext.Provider value={value}>
      <div className="flowlet-root" style={themeToStyle(theme)}>{children}</div>
    </ShellContext.Provider>
  );
}

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used within a FlowletShellProvider");
  return ctx;
}
