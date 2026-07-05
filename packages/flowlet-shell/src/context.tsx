import { createContext, useContext, useMemo, useState, type ComponentType, type ReactNode } from "react";
import type { RegisteredComponent, UINode } from "@flowlet/core";
import { themeToStyle, type FlowletTheme } from "./theme";
import { createLocalStore, type FlowletStore } from "./seams/store";
import { createLocalIntegrations, type FlowletIntegrations } from "./seams/integrations";
import { createLocalNotifications, type FlowletNotifications } from "./seams/notifications";
import { createLocalRemixes, type RemixClient } from "./seams/remixes";
import { createPageContextRegistry, type PageContextRegistry } from "./remix/page-context-registry";
import { createScopeStore, type ScopeStore } from "./remix/scope";
import type { RunQuery } from "./seams/query";
import type { ParkedActionRow } from "./components/WaitingList";
import "./styles.css";

/** Parked-action data plane (ENG-193 §4.6): list unresolved rows, resolve one
 *  yes/no. Absent → `useParkedActions` reports an empty list and no polling —
 *  the graceful no-op default every other optional seam here has. */
export interface ParkedActionsSeam {
  list: () => Promise<ParkedActionRow[]>;
  resolve: (actionId: string, decision: "yes" | "no") => Promise<void>;
}

/** Trust-screen data plane (ENG-193 §3 Moment 12): mirrors `ParkedActionsSeam`'s
 *  pattern exactly. Absent -> `useTrustData` reports empty everything, no
 *  polling — the same graceful no-op every other optional seam here has. */
export interface TrustGrantRow {
  /** Absent for automation-federated rows — not individually revokable from
   *  here (spec: "read-only + link hint"). */
  id?: string;
  tool: string;
  scopePreview: string;
  /** ENG-193 item 6: a compiled-rule-sourced grant's own loosen-rule
   *  phrasing, preferred over `scopePreview` when present. */
  plainText?: string;
  since: string;
  source: "chat" | "fade" | "compiled-rule" | "automation";
  automationName?: string;
}
/** ENG-193 item 6 — a compiled "always ask before X" rule. */
export interface TrustRuleRow {
  id: string;
  toolPattern: string;
  plainText: string;
  since: string;
}
export interface TrustAuditRow {
  at: string;
  kind: string;
  toolName?: string;
  mutating?: boolean;
  dangerous?: boolean;
}
export interface TrustSeam {
  listGrants: () => Promise<TrustGrantRow[]>;
  revokeGrant: (id: string) => Promise<void>;
  queryAudit: (opts: { sinceMs: number }) => Promise<TrustAuditRow[]>;
  listCriticalTools: () => Promise<{ name: string }[]>;
  resolveFadeProposal: (proposalId: string, accept: boolean) => Promise<void>;
  /** ENG-193 item 6 — mirrors `listGrants`/`revokeGrant` exactly. */
  listRules: () => Promise<TrustRuleRow[]>;
  revokeRule: (id: string) => Promise<void>;
}

/** What `sendConsent` resolves with (ENG-193 §4.4 addition — additive:
 *  existing `Promise<void>`-returning implementations stay assignable). */
export interface SendConsentResult {
  fadeEligible?: {
    shape: import("@flowlet/core").FadeShape;
    proposalId: string;
    /** The tracker's in-window yes-count at proposal time (review nit) —
     *  `FadeProposalCard` renders its ordinal from this instead of a
     *  hardcoded "third". Optional for backward compatibility with a host
     *  that hasn't upgraded its consent route yet. */
    count?: number;
  };
}

export type RenderNode = (node: UINode) => ReactNode;

export interface ShellContextValue {
  store: FlowletStore;
  integrations: FlowletIntegrations;
  /** Per-user pinned remixes of dev-wrapped host components (FlowletRemix). */
  remixes: RemixClient;
  /** Automation deliveries feed + approval resume (FlowletToasts). */
  notifications: FlowletNotifications;
  /** Mounted FlowletRemix anchors on the current page — created per provider,
   *  not a prop. Gives every surface "what's on this page" awareness. */
  registry: PageContextRegistry;
  /** Which anchor the shared overlay is scoped to right now (created per
   *  provider). Affordance clicks open it; the overlay clears it on close. */
  scope: ScopeStore;
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
  /** Posts a ConsentResponse (ENG-193 §4.5). Absent → approve/decline still
   *  work via the SDK's native approval boolean alone, just with no server
   *  grant/audit trail — the graceful no-op default every other seam here has.
   *  `meta.toolName` rides beside the response because the consent endpoints
   *  (`handleConsent`) require the client's tool-name assertion to cross-check
   *  against the pending part, and `ConsentResponse` itself doesn't carry it. */
  sendConsent?: (
    response: import("@flowlet/core").ConsentResponse,
    meta: { toolName: string },
  ) => Promise<SendConsentResult | void>;
  /** Parked-action data plane (ENG-193 §4.6). See `ParkedActionsSeam`. */
  parkedActions?: ParkedActionsSeam;
  /** Trust-screen data plane (ENG-193 §3 Moment 12). See `TrustSeam`. */
  trust?: TrustSeam;
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
  /** Remix persistence client; defaults to in-memory (pins reset on remount). */
  remixes?: RemixClient;
  /** Automation deliveries client; defaults to an inert empty feed. */
  notifications?: FlowletNotifications;
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
  /** Posts a ConsentResponse; see ShellContextValue. */
  sendConsent?: (
    response: import("@flowlet/core").ConsentResponse,
    meta: { toolName: string },
  ) => Promise<SendConsentResult | void>;
  /** Parked-action data plane; see ShellContextValue. */
  parkedActions?: ParkedActionsSeam;
  /** Trust-screen data plane; see ShellContextValue. */
  trust?: TrustSeam;
  children: ReactNode;
}

export function FlowletShellProvider({
  store, integrations, remixes, notifications, runQuery, refreshIntervalMs, renderNode, impls, theme, cssVars, productName, components, sendConsent, parkedActions, trust, children,
}: FlowletShellProviderProps) {
  if (store === undefined) warnNoStoreOnce();

  // Stable per provider instance: re-renders must never drop registrations.
  const [registry] = useState(createPageContextRegistry);
  const [scope] = useState(createScopeStore);

  const value = useMemo<ShellContextValue>(() => ({
    store: store ?? createLocalStore(),
    integrations: integrations ?? createLocalIntegrations([]),
    remixes: remixes ?? createLocalRemixes(),
    notifications: notifications ?? createLocalNotifications(),
    registry,
    scope,
    runQuery,
    refreshIntervalMs: refreshIntervalMs ?? 60_000,
    renderNode: renderNode ?? ((node) => defaultRenderNode(node, impls ?? {})),
    theme,
    cssVars: cssVars ?? {},
    productName,
    components,
    sendConsent,
    parkedActions,
    trust,
  }), [store, integrations, remixes, notifications, registry, scope, runQuery, refreshIntervalMs, renderNode, impls, theme, cssVars, productName, components, sendConsent, parkedActions, trust]);

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
