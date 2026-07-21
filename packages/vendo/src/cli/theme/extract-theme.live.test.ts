import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCliHarness } from "../extract/claude-cli-harness.js";
import { parseArtifact } from "../extract/harness.js";
import { composeThemeInstructions } from "../extract/stages.js";
import { contrastingText } from "./color.js";
import {
  BRAND_SLOTS,
  extractTheme,
  modelThemeSchema,
  validateSlotValue,
  type ThemeSlotValues,
  type ThemeUncertainty,
} from "./extract-theme.js";

/**
 * Live accuracy gate (kill-list §B2), ported onto the staged-extraction
 * harness path: the theme model call no longer rides extractTheme's old
 * `resolveModel` seam. Instead this mirrors exactly what `runStagedExtraction`'s
 * theme stage does — `extractTheme(root, {})` for the deterministic allowlist
 * pass, then `composeThemeInstructions` + a real `claudeCliHarness()` run for
 * whatever brand slots the allowlist left unfilled — scored against ground
 * truth read from each app's source. Skipped without a key, or without the
 * `claude` binary/login the CLI harness needs.
 *
 * Rubric (fixed in docs/superpowers/plans/2026-07-17-b2-theme-exact-or-model.md):
 * seven brand-defining slots; the gate is at least 6/7 per app, and any miss
 * must be visible (defaulted/uncertain), never a silent wrong brand.
 */

const live = typeof process.env["ANTHROPIC_API_KEY"] === "string" && process.env["ANTHROPIC_API_KEY"] !== "";
const appsDir = fileURLToPath(new URL("../../../../../apps/", import.meta.url));

const harness = claudeCliHarness();
// availability() only inspects env, not root — any root string is fine here.
const cliAvailability = live ? await harness.availability({ root: appsDir, env: process.env }) : null;
if (live && cliAvailability === null) {
  // eslint-disable-next-line no-console
  console.log("[live] skipping: ANTHROPIC_API_KEY is set but no `claude` binary/login was found on PATH");
}

interface GroundTruth {
  accent: string;
  background: string;
  surface: string;
  text: string;
  mutedText: string;
  border: string;
  /** Family prefix — fallback tails vary legitimately. */
  fontFamily: string;
}

const TRUTH: Record<string, GroundTruth> = {
  // Maple: ink-first monochrome brand (bg-ink CTAs), porcelain neutrals, Inter.
  "demo-bank": {
    accent: "#111111",
    background: "#fbfbfa",
    surface: "#ffffff",
    text: "#111111",
    mutedText: "#908c85",
    border: "#ecebe8",
    fontFamily: "inter",
  },
  // Cadence "Porcelain Ledger": ink-first — primary buttons are bg-ink and
  // the sheet itself demotes evergreen to "data only", so the accent is the
  // ink, NOT the green (the old extractor's green accent was a silent wrong
  // brand). --color-surface is the PAGE background, cards are --color-card
  // white, ink-faint is the dominant muted text (59 uses vs 34 ink-soft).
  "demo-accounting": {
    accent: "#111111",
    background: "#fbfbfa",
    surface: "#ffffff",
    text: "#111111",
    mutedText: "#908c85",
    border: "#ecebe8",
    fontFamily: "inter",
  },
};

/** The token sheet each app's ground truth above is read from — the same file
 *  the old fixed-context model pass got handed inline. Passed as evidence-path
 *  hints so the stage isn't blind-exploring for the tokens the allowlist
 *  already knows exist, matching the future init caller (which seeds
 *  evidencePaths from gatherContext's own collected CSS files). */
const EVIDENCE_PATHS: Record<string, string[]> = {
  "demo-bank": ["src/app/globals.css"],
  "demo-accounting": ["src/app/globals.css"],
};

describe.skipIf(!live || cliAvailability === null)("extractTheme live accuracy (both demo apps)", () => {
  it.each(Object.keys(TRUTH))("%s scores at least 6/7 with no silent misses", async (app) => {
    const root = join(appsDir, app);

    // Step 1: the deterministic allowlist pass ONLY — no resolveModel. This is
    // the same exact pass runStagedExtraction's caller runs before deciding
    // whether the theme stage is even needed.
    const exact = await extractTheme(root);
    const slotKeys = Object.keys(exact.slots) as Array<keyof ThemeSlotValues>;

    // Step 2: slots the exact pass did not read exactly — a missing
    // provenance (defaulted) or one that isn't a literal "--..." token
    // (a contrast/inherit derivation) both count as "needed", exactly like
    // runStagedExtraction's own `needed` computation.
    const needed = slotKeys.filter((slot) => {
      const provenance = exact.matched[slot];
      return provenance === undefined || !provenance.startsWith("--");
    });
    const brandNeeded = needed.filter((slot) => (BRAND_SLOTS as readonly string[]).includes(slot));

    const slots: ThemeSlotValues = { ...exact.slots };
    let defaulted = [...exact.defaulted];
    let uncertain: ThemeUncertainty[] = exact.uncertain;
    let stageRan = false;

    // Step 3: only when the allowlist left a brand slot unfilled does the
    // real stage path run — the SAME gate runStagedExtraction uses.
    if (brandNeeded.length > 0) {
      stageRan = true;

      const alreadyExact: Record<string, string> = {};
      for (const slot of slotKeys) {
        const provenance = exact.matched[slot];
        if (provenance !== undefined && provenance.startsWith("--")) alreadyExact[slot] = String(exact.slots[slot]);
      }

      const instructions = composeThemeInstructions({
        needed,
        alreadyExact,
        evidencePaths: EVIDENCE_PATHS[app] ?? [],
        appName: app,
      });
      const text = await harness.run({ root, env: process.env, instructions });
      const artifact = parseArtifact(text, modelThemeSchema);

      const filled = new Set<keyof ThemeSlotValues>();
      for (const slot of needed) {
        const raw = artifact.slots[slot];
        if (raw === undefined) continue;
        const value = validateSlotValue(slot, String(raw));
        if (value === null) continue;
        // Accepted values overwrite ONLY needed slots — exact reads always win.
        (slots as Record<string, unknown>)[slot] = value;
        filled.add(slot);
      }

      // Re-derive accentText by contrast when accent came from the model and
      // accentText itself wasn't an exact read (an exact accentText read
      // stands; a stale contrast derivation against the OLD accent does not).
      if (filled.has("accent")) {
        const accentTextProvenance = exact.matched["accentText"];
        const accentTextIsExact = accentTextProvenance !== undefined && accentTextProvenance.startsWith("--");
        if (!accentTextIsExact) slots.accentText = contrastingText(slots.accent);
      }

      defaulted = exact.defaulted.filter((slot) => !filled.has(slot as keyof ThemeSlotValues));
      uncertain = (artifact.uncertain ?? [])
        .filter((entry) => (BRAND_SLOTS as readonly string[]).includes(entry.slot) && (needed as readonly string[]).includes(entry.slot))
        .map((entry) => ({ slot: entry.slot as keyof ThemeSlotValues, note: entry.note }));
    }

    const truth = TRUTH[app]!;
    const misses: string[] = [];
    for (const [slot, want] of Object.entries(truth)) {
      const got = slots[slot as keyof GroundTruth].toLowerCase();
      const ok = slot === "fontFamily" ? got.startsWith(want) : got === want;
      if (!ok) misses.push(`${slot}: got ${got} want ${want}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[live] ${app}: ${7 - misses.length}/7 (theme stage ${stageRan ? "ran" : "not needed — exact pass filled everything"})`, misses, {
      needed,
      defaulted,
      uncertain,
    });

    expect(misses.length, misses.join("; ")).toBeLessThanOrEqual(1);
    // No silent wrong brand: every scored miss must be a visible default or a
    // model-flagged uncertainty, not a confidently wrong value.
    for (const miss of misses) {
      const slot = miss.split(":")[0]!;
      const visible = defaulted.includes(slot) || uncertain.some((entry) => entry.slot === slot);
      expect(visible, `silent wrong ${miss}`).toBe(true);
    }
  }, 180_000);
});
