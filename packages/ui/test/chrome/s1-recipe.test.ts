/** S1 recipe (spec §11) + build calm (spec §8) asserted on the emitted sheet
    string — the three laws that a later lane could silently undo. */
import { describe, expect, it } from "vitest";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";

describe("S1 recipe", () => {
  it("has retired frosted glass entirely", () => {
    expect(CHROME_CSS).not.toMatch(/backdrop-filter\s*:/);
    expect(CHROME_CSS).not.toMatch(/--vendo-glass/);
  });

  it("derives the hairline border from the host's text color", () => {
    expect(CHROME_CSS).toContain(
      "--vendo-border: color-mix(in srgb, var(--vendo-color-text, #14151a) 8%, transparent)",
    );
  });

  // M33 — every derived STATE indicator has to clear WCAG 1.4.11 (3:1 for
  // non-text). This computes the real number from the sheet's own default token
  // values rather than trusting the recipe by eye.
  describe("state indicators (WCAG 1.4.11)", () => {
    const fallback = (token: string): string => {
      const match = CHROME_CSS.match(new RegExp(`--vendo-${token}: var\\(--vendo-color-[a-z]+, (#[0-9a-f]{6})\\)`));
      expect(match, `--vendo-${token} carries a default`).toBeTruthy();
      return match![1]!;
    };
    const channel = (hex: string, at: number): number => {
      const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string): number =>
      0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
    const contrast = (a: string, b: string): number => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (light + 0.05) / (dark + 0.05);
    };
    const mix = (a: string, b: string, weight: number): string => {
      const part = (at: number) => {
        const value = Math.round(
          Number.parseInt(a.slice(at, at + 2), 16) * weight + Number.parseInt(b.slice(at, at + 2), 16) * (1 - weight),
        );
        return value.toString(16).padStart(2, "0");
      };
      return `#${part(1)}${part(3)}${part(5)}`;
    };

    it("derives ONE indicator token, and it clears 3:1 on the default palette", () => {
      expect(CHROME_CSS).toContain("--vendo-indicator: color-mix(in srgb, var(--vendo-fg) 50%, var(--vendo-bg))");
      const [text, background, surface] = [fallback("fg"), fallback("bg"), fallback("surface")];
      const indicator = mix(text, background, 0.5);
      expect(contrast(indicator, background)).toBeGreaterThanOrEqual(3);
      expect(contrast(indicator, surface)).toBeGreaterThanOrEqual(3);
    });

    it("uses it for every state whose only mark was a ~1:1 fill", () => {
      // The open conversation, the selected rail row, the mobile section, and a
      // tile's own edge. (The automations switch's OFF track is asserted in
      // panels.test.tsx, where the switch renders.)
      expect(CHROME_CSS).toMatch(/\.fl-rail-chat\[aria-current="page"\]::before[\s\S]{0,240}var\(--vendo-indicator\)/);
      expect(CHROME_CSS).toMatch(/\.fl-rail-row\[aria-selected="true"\]::before[\s\S]{0,240}var\(--vendo-indicator\)/);
      expect(CHROME_CSS).toMatch(/\.fl-center-head-btn\[aria-current="page"\][^}]*inset 0 -2px 0 var\(--vendo-indicator\)/);
      expect(CHROME_CSS).toMatch(/\.fl-tile \{[^}]*border: 1px solid var\(--vendo-indicator\)/);
    });
  });

  it("carries exactly one shadow token, named for floating elements only", () => {
    expect(CHROME_CSS).toContain("--vendo-shadow-float:");
    expect(CHROME_CSS).not.toMatch(/var\(--vendo-shadow\)/);
  });

  it("uses the M2 duration and easing", () => {
    expect(CHROME_CSS).toContain("--vendo-duration: 380ms");
    expect(CHROME_CSS).toContain("--vendo-ease: cubic-bezier(0.32, 0.72, 0, 1)");
  });

  it("every moving thing the center added respects prefers-reduced-motion (M29)", () => {
    const reduce = [...CHROME_CSS.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
      .map(match => match[1]!)
      .join("\n");
    // The sheet's full-width slide and its scrim, the tile hover-lift, and the
    // waiting strip's chevron rotation.
    expect(reduce).toContain(".fl-center-sheet");
    expect(reduce).toContain(".fl-center-scrim");
    expect(reduce).toMatch(/\.fl-tile:hover[^}]*transform: none/);
    expect(reduce).toMatch(/\.fl-tile--ghost:hover[^}]*transform: none/);
    expect(reduce).toMatch(/\.fl-waiting-strip > summary::after \{ transition: none; \}/);
  });

  it("animates exactly one element while a card builds — the boot hairline", () => {
    const building = [...CHROME_CSS.matchAll(/^[^\n{]*\[data-state="building"\][^{]*\{[^}]*\}/gm)]
      .map((match) => match[0])
      // `animation: none` is a rule that TAKES a loop away (M19) — it is not one
      // of the animations this law counts.
      .filter((rule) => /animation\s*:/.test(rule) && !/animation\s*:\s*none/.test(rule));
    expect(building).toHaveLength(1);
    expect(building[0]).toContain(".fl-boot-hairline");
  });

  it("a building card silences the streaming caret and any shimmer (M19)", () => {
    // The caret runs in TWO places (the lone caret, and the pseudo-element that
    // trails streamed prose) and the shimmer bar in a third — all three had to
    // stand down, or §8's one-animation law is false in the common frame.
    for (const target of [".fl-caret", ".fl-md--streaming > :last-child::after", ".fl-skeleton-bar"]) {
      expect(CHROME_CSS, `${target} stands down during a build`)
        .toContain(`.fl-thread:has(.fl-appcard-bar[data-state="building"]) ${target}`);
    }
    expect(CHROME_CSS).toMatch(/:has\(\.fl-appcard-bar\[data-state="building"\]\) \.fl-skeleton-bar \{ animation: none; \}/);
  });
});
