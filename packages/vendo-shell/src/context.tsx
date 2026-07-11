import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import type { UINode } from "@vendoai/core";
import { themeToStyle, type VendoTheme } from "./theme";
import { createLocalIntegrations, type VendoIntegrations } from "./seams/integrations";
import { createLocalNotifications, type VendoNotifications } from "./seams/notifications";
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
    shape: import("@vendoai/core").FadeShape;
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
  integrations: VendoIntegrations;
  /** Automation deliveries feed + approval resume (VendoToasts). */
  notifications: VendoNotifications;
  renderNode: RenderNode;
  /** Host brand theme — so portaled surfaces (the overlay) can re-apply it. */
  theme?: VendoTheme;
  /** Opaque `--vendo-*` var map (from the host's brand). Applied INLINE on every
   *  `.vendo-root` element so it overrides the vars styles.css declares there —
   *  an ancestor's vars would lose to that element-level declaration. The shell is
   *  a dumb applier: it never inspects or produces these, just spreads them. */
  cssVars?: Record<string, string>;
  /** What the host calls its assistant (e.g. "Maple"). Default copy that names
   *  the product reads it — the shell package itself ships ZERO brand strings. */
  productName?: string;
  /** Posts a ConsentResponse (ENG-193 §4.5). Absent → approve/decline still
   *  work via the SDK's native approval boolean alone, just with no server
   *  grant/audit trail — the graceful no-op default every other seam here has.
   *  `meta.toolName` rides beside the response because the consent endpoints
   *  (`handleConsent`) require the client's tool-name assertion to cross-check
   *  against the pending part, and `ConsentResponse` itself doesn't carry it. */
  sendConsent?: (
    response: import("@vendoai/core").ConsentResponse,
    meta: { toolName: string },
  ) => Promise<SendConsentResult | void>;
  /** Parked-action data plane (ENG-193 §4.6). See `ParkedActionsSeam`. */
  parkedActions?: ParkedActionsSeam;
  /** Trust-screen data plane (ENG-193 §3 Moment 12). See `TrustSeam`. */
  trust?: TrustSeam;
}

const ShellContext = createContext<ShellContextValue | null>(null);

type ImplMap = Record<string, ComponentType<Record<string, unknown>>>;

/**
 * Non-production default renderer. Renders component nodes via the provided `impls`
 * map and a placeholder for generated nodes. The real sandboxed renderer
 * (`VendoStage` from `@vendoai/react`, F3) drops in via the `renderNode` seam.
 */
function defaultRenderNode(node: UINode, impls: ImplMap): ReactNode {
  if (node.kind === "component") {
    const Impl = impls[node.name];
    if (!Impl) return <div data-testid="unimpl-node">{node.name} (no impl)</div>;
    return <Impl {...(node.props as Record<string, unknown>)} />;
  }
  return <div data-testid="generated-placeholder">[generated UI — rendered in the F3 sandbox]</div>;
}

export interface VendoShellProviderProps {
  integrations?: VendoIntegrations;
  /** Automation deliveries client; defaults to an inert empty feed. */
  notifications?: VendoNotifications;
  /** Override the render surface. Default is a non-production fallback; wire F3's
   *  sandboxed `VendoStage` here for real generated UI. */
  renderNode?: RenderNode;
  /** Component impls for the default fallback renderNode. */
  impls?: ImplMap;
  theme?: VendoTheme;
  /** Opaque `--vendo-*` var map from the host brand; applied inline on `.vendo-root`. */
  cssVars?: Record<string, string>;
  /** What the host calls its assistant; read by default copy that names it. */
  productName?: string;
  /** Posts a ConsentResponse; see ShellContextValue. */
  sendConsent?: (
    response: import("@vendoai/core").ConsentResponse,
    meta: { toolName: string },
  ) => Promise<SendConsentResult | void>;
  /** Parked-action data plane; see ShellContextValue. */
  parkedActions?: ParkedActionsSeam;
  /** Trust-screen data plane; see ShellContextValue. */
  trust?: TrustSeam;
  children: ReactNode;
}

export function VendoShellProvider({
  integrations, notifications, renderNode, impls, theme, cssVars, productName, sendConsent, parkedActions, trust, children,
}: VendoShellProviderProps) {
  const value = useMemo<ShellContextValue>(() => ({
    integrations: integrations ?? createLocalIntegrations([]),
    notifications: notifications ?? createLocalNotifications(),
    renderNode: renderNode ?? ((node) => defaultRenderNode(node, impls ?? {})),
    theme,
    cssVars: cssVars ?? {},
    productName,
    sendConsent,
    parkedActions,
    trust,
  }), [integrations, notifications, renderNode, impls, theme, cssVars, productName, sendConsent, parkedActions, trust]);

  return (
    <ShellContext.Provider value={value}>
      <div className="vendo-root" style={{ ...themeToStyle(theme), ...cssVars }}>{children}</div>
    </ShellContext.Provider>
  );
}

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used within a VendoShellProvider");
  return ctx;
}
