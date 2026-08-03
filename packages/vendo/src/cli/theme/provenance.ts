import { join } from "node:path";
import { readOptional, writeText } from "../shared.js";
import { normalizeColor } from "./color.js";
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
 * The law is one line: a slot is machine-owned ONLY when the base records it
 * and `theme.json` still holds exactly that value. Everything else is pinned.
 *   • recorded and unchanged → machine-extracted; a new extraction updates it
 *   • recorded and different → hand-edited; pinned and reported
 *   • not recorded at all (no base file yet, or a token init never saw) →
 *     pinned, because there is no evidence about who chose the value on disk
 *
 * That last rule is deliberately conservative. An earlier draft treated "the
 * value equals Vendo's neutral default" as proof the machine wrote it — but
 * the neutral defaults are ordinary Tailwind palette values (`#2563eb` is
 * blue-600, the greys are the slate ramp), so a human who picks blue-600 would
 * have had it silently overwritten. Unprovable ownership is never ownership.
 *
 * The base only advances on an unambiguous run (no pinned slots), so an
 * install from before the base existed warns with the diff on every sync until
 * a human resolves it with `--theme-refresh` — never quietly adopting a stale
 * value as the new truth.
 */

export const THEME_EXTRACTED_FILE = "theme.extracted.json";
const FORMAT = "vendo/theme-extracted@1";

export interface ExtractedThemeBase {
  format: string;
  /** Only the slots the deterministic scan had host evidence for (exact token
      reads, plus the values derived from them). Slots that fell back to a
      neutral default are absent — Vendo never claims to have read them.
      Deliberately the whole file: no timestamp, because a timestamp carries no
      decision and would make the committed artifact churn on every sync. */
  slots: Partial<Record<keyof ThemeSlotValues, string>>;
}

/** Where each slot lives inside the frozen VendoTheme shape. Key ORDER is
    load-bearing, mirroring DEFAULT_THEME_SLOTS: every DERIVED_FROM source must
    precede its dependent so the merge knows the source's fate first. */
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

/** Two slot values are "the same" when they mean the same thing: `#FFFFFF` and
    `#ffffff` are one color, and reading a case difference as a hand edit would
    pin the slot forever. Non-color slots compare trimmed. */
function sameValue(left: string, right: string): boolean {
  if (left.trim() === right.trim()) return true;
  const [a, b] = [normalizeColor(left), normalizeColor(right)];
  return a !== null && a === b;
}

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
  return { format: FORMAT, slots };
}

/** Write the base only when its slots actually changed. `.vendo/` is committed
    and sync runs from `predev`, so a base that rewrote itself on every run
    would dirty every contributor's tree on every `npm run dev` — the exact
    churn the hookless `--no-ai` flag exists to prevent. */
export async function writeBase(vendoDir: string, base: ExtractedThemeBase): Promise<boolean> {
  const current = await readBase(vendoDir);
  if (current !== null && sameSlots(current.slots, base.slots)) return false;
  await writeText(join(vendoDir, THEME_EXTRACTED_FILE), `${JSON.stringify(base, null, 2)}\n`);
  return true;
}

function sameSlots(left: ExtractedThemeBase["slots"], right: ExtractedThemeBase["slots"]): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const [a, b] = [left[key as keyof ThemeSlotValues], right[key as keyof ThemeSlotValues]];
    if (a === undefined || b === undefined ? a !== b : !sameValue(a, b)) return false;
  }
  return true;
}

/** The recorded base, or null when absent/unreadable (both mean "no recorded
    provenance" — never a reason to fail a sync). */
export async function readBase(vendoDir: string): Promise<ExtractedThemeBase | null> {
  const raw = await readOptional(join(vendoDir, THEME_EXTRACTED_FILE));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ExtractedThemeBase>;
    if (typeof parsed.slots !== "object" || parsed.slots === null) return null;
    return { format: FORMAT, slots: parsed.slots };
  } catch {
    return null;
  }
}

/** Slots the extractor DERIVES from another slot rather than reading: the
    accent's contrast text, and the heading stack that inherits the body's.
    A derived slot may only move when its source moves — otherwise a pinned
    accent keeps the human's colour while its contrast text follows the app's,
    which is how `#2563eb` ended up with `#000000` on it. */
const DERIVED_FROM: ReadonlyArray<[keyof ThemeSlotValues, keyof ThemeSlotValues]> = [
  ["accentText", "accent"],
  ["headingFamily", "fontFamily"],
];

export interface ThemeMerge {
  /** The theme document to write; null when nothing changed. */
  theme: unknown | null;
  /** Slots this sync actually wrote into `theme.json` — never a slot that was
      merely reconsidered, because the summary line names these to the user. */
  updated: string[];
  /** Slots the extraction disagrees with but a human owns, carrying BOTH
      values so the report can show the choice instead of implying one. */
  pinned: Array<{ slot: string; mine: string; theirs: string }>;
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
  const pinned: ThemeMerge["pinned"] = [];
  const held = new Set<string>();
  let radiusWas: string | undefined;

  for (const [slot, path] of SLOT_PATHS) {
    if (defaulted.has(slot)) continue; // no host evidence — nothing to say
    const extracted = String(summary.slots[slot]);
    const current = readPath(args.theme, path);
    if (current === undefined || sameValue(current, extracted)) continue;
    // A derived slot is only as movable as the slot it derives from. Its
    // extracted value was computed from the app's source slot, so applying it
    // over a PINNED source produces an incoherent pair (the human's accent
    // with the app's contrast text). Held silently: nothing was mis-written,
    // and the pinned source is already named in the report.
    const source = DERIVED_FROM.find(([derived]) => derived === slot)?.[1];
    if (source !== undefined && held.has(source)) continue;
    // Machine-owned ONLY with recorded proof. No base entry means no evidence
    // about who chose the value on disk, so it is the human's — never guessed
    // from "it looks like our default".
    const recorded = base?.slots[slot];
    const machineOwned = recorded !== undefined && sameValue(current, recorded);
    if (!machineOwned && args.force !== true) {
      pinned.push({ slot, mine: current, theirs: extracted });
      held.add(slot);
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

  return { theme: updated.length === 0 ? null : next, updated, pinned };
}
