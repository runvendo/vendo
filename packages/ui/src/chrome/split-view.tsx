/** 2026-07 demo feedback — the expandable split-view workspace.
 *
 * The centered overlay modal is a fine conversation surface but a cramped one
 * for microapps: the generated view competes with the transcript inside one
 * ~620px column. Expanding animates the modal into a near-fullscreen
 * workspace — the FEATURED microapp renders large in a left stage (~2/3
 * width) while the conversation docks as a right-hand rail (~1/3, min
 * 360px) with the composer at its bottom. Collapse animates back; the
 * conversation NEVER remounts across the flip (same rule as close/reopen —
 * the DOM hierarchy around the thread is identical in both states, only CSS
 * changes).
 *
 * This module is the state machine (pure, unit-tested) plus the context the
 * thread's app cards use to register embeds and feature themselves. The
 * VendoOverlay owns the reducer instance and the layout/animation shell.
 */
import { createContext, useContext } from "react";

export interface SplitEmbed {
  appId: string;
  payload: unknown;
}

export interface SplitViewState {
  /** Whether the workspace layout is active. */
  expanded: boolean;
  /** The user's explicit pick; undefined = follow the latest embed. */
  selectedAppId: string | undefined;
  /** Registered app embeds in thread order (latest last). */
  embeds: SplitEmbed[];
}

export const initialSplitViewState: SplitViewState = {
  expanded: false,
  selectedAppId: undefined,
  embeds: [],
};

export type SplitViewAction =
  | { type: "expand" }
  | { type: "collapse" }
  | { type: "toggle" }
  /** An explicit user pick (clicking an app embed in the rail). */
  | { type: "feature"; appId: string }
  /** An app embed rendered (or its payload updated) in the thread. A repeat
      registration moves the embed to "latest" only when its payload changed
      message identity — re-renders keep order. */
  | { type: "embed"; appId: string; payload: unknown }
  /** The embed left the thread (unmounted with the conversation). */
  | { type: "remove-embed"; appId: string };

export function splitViewReducer(state: SplitViewState, action: SplitViewAction): SplitViewState {
  switch (action.type) {
    case "expand":
      return state.expanded ? state : { ...state, expanded: true };
    case "collapse":
      return state.expanded ? { ...state, expanded: false } : state;
    case "toggle":
      return { ...state, expanded: !state.expanded };
    case "feature": {
      if (!state.embeds.some(embed => embed.appId === action.appId)) return state;
      return { ...state, selectedAppId: action.appId };
    }
    case "embed": {
      const existing = state.embeds.findIndex(embed => embed.appId === action.appId);
      if (existing >= 0) {
        const embeds = [...state.embeds];
        embeds[existing] = { appId: action.appId, payload: action.payload };
        return { ...state, embeds };
      }
      return { ...state, embeds: [...state.embeds, { appId: action.appId, payload: action.payload }] };
    }
    case "remove-embed": {
      if (!state.embeds.some(embed => embed.appId === action.appId)) return state;
      return {
        ...state,
        embeds: state.embeds.filter(embed => embed.appId !== action.appId),
        // A removed explicit pick falls back to following the latest.
        selectedAppId: state.selectedAppId === action.appId ? undefined : state.selectedAppId,
      };
    }
  }
}

/** The stage's app: the explicit pick when it still exists, else the most
    recent embed in the thread. */
export function featuredEmbed(state: SplitViewState): SplitEmbed | undefined {
  if (state.selectedAppId !== undefined) {
    const selected = state.embeds.find(embed => embed.appId === state.selectedAppId);
    if (selected) return selected;
  }
  return state.embeds.at(-1);
}

/** Escape order: collapse the workspace first, close the overlay second. */
export function escapeIntent(state: SplitViewState): "collapse" | "close" {
  return state.expanded ? "collapse" : "close";
}

/** What the overlay hands the thread subtree. Null outside a split-capable
    surface (embedded VendoThread, VendoPage) — app cards then behave exactly
    as before. */
export interface SplitViewContextValue {
  expanded: boolean;
  featuredAppId: string | undefined;
  feature(appId: string): void;
  /** Expand the workspace with THIS app featured — the compact card's
      prominent Expand affordance (2026-07 demo feedback). */
  expandTo(appId: string): void;
  registerEmbed(appId: string, payload: unknown): void;
  removeEmbed(appId: string): void;
}

export const SplitViewContext = createContext<SplitViewContextValue | null>(null);

export function useSplitView(): SplitViewContextValue | null {
  return useContext(SplitViewContext);
}

/* ------------------------------------------------------------------ */
/* Embed morph geometry (the fluid expand)                             */
/* ------------------------------------------------------------------ */

export interface MorphRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** MUST mirror the chrome-css split-view constants — update together:
 *  `.fl-overlay-panel[data-vendo-expanded] { width: min(1500px, 96vw);
 *  height: min(940px, 94vh); }` (centered fixed panel, 1px border) and
 *  `.fl-split-rail { flex-basis: max(360px, 33.5%); }`. */
const EXPANDED = {
  panelMaxW: 1500,
  panelVw: 0.96,
  panelMaxH: 940,
  panelVh: 0.94,
  border: 1,
  railMin: 360,
  railFraction: 0.335,
};

/** Where the stage PANE will sit once the expand transition settles — the
 *  target rect for the embed's FLIP ghost. Computed (not measured) because a
 *  CSS transition interpolates: at flight time the DOM still reports the
 *  compact layout, and suppressing the transitions to measure would kill the
 *  panel spring the ghost rides alongside. */
export function expandedStageRect(viewport: { width: number; height: number }): MorphRect {
  const panelWidth = Math.min(EXPANDED.panelMaxW, viewport.width * EXPANDED.panelVw);
  const panelHeight = Math.min(EXPANDED.panelMaxH, viewport.height * EXPANDED.panelVh);
  const contentWidth = panelWidth - 2 * EXPANDED.border;
  const railWidth = Math.max(EXPANDED.railMin, contentWidth * EXPANDED.railFraction);
  return {
    top: (viewport.height - panelHeight) / 2 + EXPANDED.border,
    left: (viewport.width - panelWidth) / 2 + EXPANDED.border,
    width: contentWidth - railWidth,
    height: panelHeight - 2 * EXPANDED.border,
  };
}
