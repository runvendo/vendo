import { join } from "node:path";
import { readOptional, writeText } from "../shared.js";
import type { ThemeSlotValues, ThemeSummary } from "./extract-theme.js";

/**
 * Theme provenance — how `vendo sync` re-extracts a rebrand without ever
 * clobbering a hand edit.
 *
 * `.vendo/theme.json` is the editable source of truth and stays exactly the
 * frozen `VendoTheme` shape, so provenance rides a sibling merge base:
 * `.vendo/theme.extracted.json` records what the DETERMINISTIC scan produced
 * the last time it ran. That mirrors the split `.vendo/` already lives by —
 * `tools.json`/`judgments.json` are the machine layer, `overrides.json` is
 * "what a person decided" — instead of inventing a second convention.
 *
 * The law, per slot:
 *   • in the base and `theme.json` still equals it → machine-extracted; a new
 *     extraction updates it
 *   • in the base and `theme.json` differs → hand-edited; pinned and reported
 *   • not in the base (the host grew a token init never saw) → updated only
 *     while `theme.json` still holds Vendo's neutral default, else pinned
 *
 * No base file yet (installs from before this landed): nothing is machine-
 * owned, so nothing is touched. When the extraction agrees with `theme.json`
 * everywhere the base bootstraps silently; when it disagrees the run warns
 * with the diff every time until a human resolves it with `--theme-refresh`.
 */

export const THEME_EXTRACTED_FILE = "theme.extracted.json";
const FORMAT = "vendo/theme-extracted@1";

export interface ExtractedThemeBase {
  format: string;
  at: string;
  /** Only the slots the deterministic scan had host evidence for (exact token
      reads, plus the values derived from them). Slots that fell back to a
      neutral default are absent — Vendo never claims to have read them. */
  slots: Partial<Record<keyof ThemeSlotValues, string>>;
}

/** Where each slot lives inside the frozen VendoTheme shape. */
const SLOT_PATHS: ReadonlyArray<[keyof ThemeSlotValues, readonly string[]]> = [
  ["accent", ["colors", "accent"]],
  ["accentText", ["colors", "accentText"]],
  ["background", ["colors", "background"]],
  ["border", ["colors", "border"]],
  ["danger", ["colors", "danger"]],
  ["surface", ["colors", "surface"]],
  ["text", ["colors", "text"]],
  ["mutedText", ["colors", "muted"]],
  ["radius", ["radius", "medium"]],
  ["fontFamily", ["typography", "fontFamily"]],
  ["headingFamily", ["typography", "headingFamily"]],
  ["baseSize", ["typography", "baseSize"]],
  ["density", ["density"]],
  ["motion", ["motion"]],
];

/** Vendo's brand-neutral fallbacks — the only values sync may overwrite when
    it has no recorded provenance for a slot (they are demonstrably ours). */
const NEUTRAL_DEFAULTS: Record<string, string> = {
  accent: "#2563eb",
  accentText: "#ffffff",
  background: "#ffffff",
  border: "#e2e8f0",
  danger: "#dc2626",
  surface: "#f8fafc",
  text: "#0f172a",
  mutedText: "#64748b",
  radius: "8px",
  fontFamily: "system-ui, sans-serif",
  headingFamily: "system-ui, sans-serif",
  baseSize: "16px",
  density: "comfortable",
  motion: "full",
};

function readPath(theme: unknown, path: readonly string[]): string | undefined {
  let cursor: unknown = theme;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

function writePath(theme: Record<string, unknown>, path: readonly string[], value: string): void {
  let cursor = theme;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (typeof next !== "object" || next === null) return;
    cursor = next as Record<string, unknown>;
  }
  cursor[path[path.length - 1]!] = value;
}

/** The deterministic scan's evidence, as the merge base. Built from the
    EXACT-ONLY summary (before any model fill or `--theme` answer): those are
    human/model decisions, and pinning them is the point. */
export function baseFrom(summary: ThemeSummary): ExtractedThemeBase {
  const defaulted = new Set(summary.defaulted);
  const slots: Partial<Record<keyof ThemeSlotValues, string>> = {};
  for (const [slot] of SLOT_PATHS) {
    if (defaulted.has(slot)) continue;
    slots[slot] = String(summary.slots[slot]);
  }
  return { format: FORMAT, at: new Date().toISOString(), slots };
}

export async function writeBase(vendoDir: string, base: ExtractedThemeBase): Promise<void> {
  await writeText(join(vendoDir, THEME_EXTRACTED_FILE), `${JSON.stringify(base, null, 2)}\n`);
}

/** The recorded base, or null when absent/unreadable (both mean "no recorded
    provenance" — never a reason to fail a sync). */
export async function readBase(vendoDir: string): Promise<ExtractedThemeBase | null> {
  const raw = await readOptional(join(vendoDir, THEME_EXTRACTED_FILE));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ExtractedThemeBase>;
    if (typeof parsed.slots !== "object" || parsed.slots === null) return null;
    return { format: FORMAT, at: String(parsed.at ?? ""), slots: parsed.slots };
  } catch {
    return null;
  }
}

export interface ThemeMerge {
  /** The theme document to write; null when nothing changed. */
  theme: unknown | null;
  /** Slots this sync updated to the new extraction. */
  updated: string[];
  /** Slots the extraction disagrees with but a human owns — left alone. */
  pinned: string[];
  /** True when `theme.json` and the new extraction already agree everywhere
      the scan has evidence: safe to (re)write the base with no questions. */
  clean: boolean;
}

/**
 * Merge a fresh deterministic extraction into the host's `theme.json`.
 * `force` (sync `--theme-refresh`) takes every disagreement, pinned or not.
 */
export function mergeExtraction(args: {
  theme: unknown;
  base: ExtractedThemeBase | null;
  summary: ThemeSummary;
  force?: boolean;
}): ThemeMerge {
  const { summary, base } = args;
  const defaulted = new Set(summary.defaulted);
  const next = structuredClone(args.theme) as Record<string, unknown>;
  const updated: string[] = [];
  const pinned: string[] = [];
  let radiusWas: string | undefined;

  for (const [slot, path] of SLOT_PATHS) {
    if (defaulted.has(slot)) continue; // no host evidence — nothing to say
    const extracted = String(summary.slots[slot]);
    const current = readPath(args.theme, path);
    if (current === undefined || current === extracted) continue;
    const recorded = base?.slots[slot];
    const machineOwned = recorded === undefined
      ? current === NEUTRAL_DEFAULTS[slot]
      : current === recorded;
    if (!machineOwned && args.force !== true) {
      pinned.push(slot);
      continue;
    }
    if (slot === "radius") radiusWas = current;
    writePath(next, path, extracted);
    updated.push(slot);
  }

  // radius.small/large are derived from medium (init's toVendoTheme), so they
  // follow a medium update only while they still hold the derived values —
  // a hand-tuned corner radius survives, like every other hand edit.
  if (radiusWas !== undefined) {
    const factorOf = (value: string): number | null => {
      const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
      return px === null ? null : Number(px[1]);
    };
    const before = factorOf(radiusWas);
    const after = factorOf(String(summary.slots.radius));
    if (before !== null && after !== null) {
      for (const [key, factor] of [["small", 0.5], ["large", 1.5]] as const) {
        if (readPath(args.theme, ["radius", key]) === `${before * factor}px`) {
          writePath(next, ["radius", key], `${after * factor}px`);
        }
      }
    }
  }

  return {
    theme: updated.length === 0 ? null : next,
    updated,
    pinned,
    clean: updated.length === 0 && pinned.length === 0,
  };
}
