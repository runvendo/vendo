import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import type { UINode } from "@flowlet/core";
import { themeToStyle, type FlowletTheme } from "./theme";
import { createLocalStore, type FlowletStore } from "./seams/store";
import { createLocalIntegrations, type FlowletIntegrations } from "./seams/integrations";
import "./styles.css";

export type RenderNode = (node: UINode) => ReactNode;

export interface ShellContextValue {
  store: FlowletStore;
  integrations: FlowletIntegrations;
  renderNode: RenderNode;
  /** Host brand theme — so portaled surfaces (the overlay) can re-apply it. */
  theme?: FlowletTheme;
}

const ShellContext = createContext<ShellContextValue | null>(null);

/** Fire the no-store dev warning at most once per module lifetime. */
let warnedNoStore = false;
function warnNoStoreOnce() {
  if (warnedNoStore || process.env.NODE_ENV === "production") return;
  warnedNoStore = true;
  console.warn(
    "[flowlet] No `store` prop passed to FlowletShellProvider; using an in-memory " +
      "store that resets on remount. Saved views will not persist. Pass a `store` (see ENG-183).",
  );
}

type ImplMap = Record<string, ComponentType<Record<string, unknown>>>;

/**
 * Non-production default renderer. Renders component nodes via the provided `impls`
 * map and a placeholder for generated nodes. The real sandboxed renderer
 * (`FlowletStage` from `@flowlet/react`, F3) drops in via the `renderNode` seam.
 */
function defaultRenderNode(node: UINode, impls: ImplMap): ReactNode {
  if (node.kind === "component") {
    const Impl = impls[node.name];
    if (!Impl) return <div data-testid="unimpl-node">{node.name} (no impl)</div>;
    return <Impl {...(node.props as Record<string, unknown>)} />;
  }
  return <div data-testid="generated-placeholder">[generated UI — rendered in the F3 sandbox]</div>;
}

export interface FlowletShellProviderProps {
  store?: FlowletStore;
  integrations?: FlowletIntegrations;
  /** Override the render surface. Default is a non-production fallback; wire F3's
   *  sandboxed `FlowletStage` here for real generated UI. */
  renderNode?: RenderNode;
  /** Component impls for the default fallback renderNode. */
  impls?: ImplMap;
  theme?: FlowletTheme;
  children: ReactNode;
}

export function FlowletShellProvider({
  store, integrations, renderNode, impls, theme, children,
}: FlowletShellProviderProps) {
  if (store === undefined) warnNoStoreOnce();

  const value = useMemo<ShellContextValue>(() => ({
    store: store ?? createLocalStore(),
    integrations: integrations ?? createLocalIntegrations([]),
    renderNode: renderNode ?? ((node) => defaultRenderNode(node, impls ?? {})),
    theme,
  }), [store, integrations, renderNode, impls, theme]);

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
