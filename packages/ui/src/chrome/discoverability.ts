/** Fire-once flags for discoverability elements (ui-usage-dx §6).
 *
 *  Hard rule: every discoverability element renders at most once per user per
 *  deployment, ever — localStorage (origin-scoped, so per-deployment) is the
 *  source of truth, and any degraded environment (SSR, sandboxed iframe,
 *  blocked or full storage) reads as already-seen so it never nags. */

/** The one host-facing discoverability dial (ui-usage-dx §6): `"default"`
 *  keeps the fire-once whisper + greeting-as-tutorial; `"quiet"` disables
 *  both. Contextual affordances (slot ghosts, remix hover, triggers) are
 *  host-placed and untouched by the dial. */
export type VendoDiscoverability = "quiet" | "default";

/** The greeting-as-tutorial content (§6 first-open moment): an agent-voiced
 *  intro line plus 2–3 tappable starter prompts (chips PREFILL the composer,
 *  never send). Hosts supply it via the provider/overlay `greeting` prop —
 *  typically loaded from `.vendo/greeting.json`, which uses this exact shape. */
export interface VendoGreeting {
  intro: string;
  prompts: string[];
}

/** Fallback greeting when the host supplies none: a generic capable intro
 *  whose second prompt is always a molding prompt (the §6 requirement). */
export const defaultVendoGreeting: VendoGreeting = {
  intro: "Hi — I'm built into this app. Ask me questions, hand me tasks, or have me reshape a screen to fit how you work.",
  prompts: ["What can you do here?", "Rebuild this page around what I use most"],
};

const PREFIX = "vendo:discoverability:";

function storage(): Storage | null {
  try {
    // The ACCESS itself can throw (sandboxed iframes, partitioned storage).
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** True once the element has fired — or whenever storage cannot answer. */
export function hasSeen(element: string): boolean {
  const store = storage();
  if (!store) return true;
  try {
    return store.getItem(PREFIX + element) !== null;
  } catch {
    return true;
  }
}

/** Record the element as fired. Best-effort: a write that fails stays silent
 *  (the matching hasSeen already reports seen in those environments). */
export function markSeen(element: string): void {
  try {
    storage()?.setItem(PREFIX + element, "1");
  } catch {
    /* quota/denied — nothing to do */
  }
}
