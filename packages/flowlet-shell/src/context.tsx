import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import type { RegisteredComponent, UINode } from "@flowlet/core";
import { themeToStyle, type FlowletTheme } from "./theme";
import { createLocalStore, type FlowletStore } from "./seams/store";
import { createLocalIntegrations, type FlowletIntegrations } from "./seams/integrations";
import type { RunQuery } from "./seams/query";
import "./styles.css";

export type RenderNode = (node: UINode) => ReactNode;

export interface ShellContextValue {
  store: FlowletStore;
  integrations: FlowletIntegrations;
  /** Host seam: re-run one declared data query through the policy-governed
   *  tool path (ENG-183). Absent → reopened views stay snapshots. */
  runQuery?: RunQuery;
  /** Live-refresh cadence for OPEN saved views (ms). Ticks only while the tab
   *  is visible and stop after repeated failures. 0 disables. Default 60s. */
  refreshIntervalMs: number;
  renderNode: RenderNode;
  /** Host brand theme — so portaled surfaces (the overlay) can re-apply it. */
  theme?: FlowletTheme;
  /** Opaque `--flowlet-*` var map (from the host's brand). Applied INLINE on every
   *  `.flowlet-root` element so it overrides the vars styles.css declares there —
   *  an ancestor's vars would lose to that element-level declaration. The shell is
   *  a dumb applier: it never inspects or produces these, just spreads them. */
  cssVars?: Record<string, string>;
  /** What the host calls its assistant (e.g. "Maple"). Default copy that names
   *  the product reads it — the shell package itself ships ZERO brand strings. */
  productName?: string;
  /** F1 component registry (prewired + host). When present, reopened saved
   *  views diff their stamp against it and surface drift (ENG-186). */
  components?: RegisteredComponent[];
}

const ShellContext = createContext<ShellContextValue | null>(null);

/** Fire the no-store dev warning at most once per module lifetime. */
let warnedNoStore = false;
function warnNoStoreOnce() {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (warnedNoStore || env?.NODE_ENV === "production") return;
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
  /** Host seam for reopening saved views with fresh data; see ShellContextValue. */
  runQuery?: RunQuery;
  /** Live-refresh cadence for open saved views (ms); 0 disables. Default 60s. */
  refreshIntervalMs?: number;
  /** Override the render surface. Default is a non-production fallback; wire F3's
   *  sandboxed `FlowletStage` here for real generated UI. */
  renderNode?: RenderNode;
  /** Component impls for the default fallback renderNode. */
  impls?: ImplMap;
  theme?: FlowletTheme;
  /** Opaque `--flowlet-*` var map from the host brand; applied inline on `.flowlet-root`. */
  cssVars?: Record<string, string>;
  /** What the host calls its assistant; read by default copy that names it. */
  productName?: string;
  /** F1 component registry; enables drift detection on reopened saved views. */
  components?: RegisteredComponent[];
  children: ReactNode;
}

export function FlowletShellProvider({
  store, integrations, runQuery, refreshIntervalMs, renderNode, impls, theme, cssVars, productName, components, children,
}: FlowletShellProviderProps) {
  if (store === undefined) warnNoStoreOnce();

  const value = useMemo<ShellContextValue>(() => ({
    store: store ?? createLocalStore(),
    integrations: integrations ?? createLocalIntegrations([]),
    runQuery,
    refreshIntervalMs: refreshIntervalMs ?? 60_000,
    renderNode: renderNode ?? ((node) => defaultRenderNode(node, impls ?? {})),
    theme,
    cssVars: cssVars ?? {},
    productName,
    components,
  }), [store, integrations, runQuery, refreshIntervalMs, renderNode, impls, theme, cssVars, productName, components]);

  return (
    <ShellContext.Provider value={value}>
      <div className="flowlet-root" style={{ ...themeToStyle(theme), ...cssVars }}>{children}</div>
    </ShellContext.Provider>
  );
}

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used within a FlowletShellProvider");
  return ctx;
}
