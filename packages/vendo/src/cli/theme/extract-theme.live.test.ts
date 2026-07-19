import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import { describe, expect, it } from "vitest";
import { extractTheme } from "./extract-theme.js";

/**
 * Live accuracy gate (kill-list §B2): full exact-or-model pipeline against
 * both demo apps, through the REAL refine model seam (the host app's own
 * @ai-sdk/anthropic + ANTHROPIC_API_KEY), scored against ground truth read
 * from each app's source. Skipped without a key.
 *
 * Rubric (fixed in docs/superpowers/plans/2026-07-17-b2-theme-exact-or-model.md):
 * seven brand-defining slots; the gate is at least 6/7 per app, and any miss
 * must be visible (defaulted/uncertain), never a silent wrong brand.
 */

const live = typeof process.env["ANTHROPIC_API_KEY"] === "string" && process.env["ANTHROPIC_API_KEY"] !== "";
const appsDir = fileURLToPath(new URL("../../../../../apps/", import.meta.url));

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

describe.skipIf(!live)("extractTheme live accuracy (both demo apps)", () => {
  it.each(Object.keys(TRUTH))("%s scores at least 6/7 with no silent misses", async (app) => {
    const root = join(appsDir, app);
    // Mirrors resolveRefineModel's default composition (host key +
    // @ai-sdk/anthropic + the init-starter model). The seam itself cannot be
    // exercised under vite-node — its file-URL dynamic import breaks on
    // worktree paths containing spaces — and is covered by refine's unit
    // tests and the real CLI path.
    const result = await extractTheme(root, {
      resolveModel: async () => createAnthropic({ apiKey: process.env["ANTHROPIC_API_KEY"]! })("claude-sonnet-4-6"),
    });

    const truth = TRUTH[app]!;
    const misses: string[] = [];
    for (const [slot, want] of Object.entries(truth)) {
      const got = result.slots[slot as keyof GroundTruth].toLowerCase();
      const ok = slot === "fontFamily" ? got.startsWith(want) : got === want;
      if (!ok) misses.push(`${slot}: got ${got} want ${want}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[live] ${app}: ${7 - misses.length}/7`, misses, {
      usedModel: result.usedModel,
      defaulted: result.defaulted,
      uncertain: result.uncertain,
      errors: result.errors,
    });

    expect(misses.length, misses.join("; ")).toBeLessThanOrEqual(1);
    // No silent wrong brand: every scored miss must be a visible default or a
    // model-flagged uncertainty, not a confidently wrong value.
    for (const miss of misses) {
      const slot = miss.split(":")[0]!;
      const visible = result.defaulted.includes(slot)
        || result.uncertain.some((entry) => entry.slot === slot);
      expect(visible, `silent wrong ${miss}`).toBe(true);
    }
  }, 180_000);
});
