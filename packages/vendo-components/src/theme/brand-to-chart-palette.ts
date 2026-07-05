import type { BrandTokens } from "./brand";

/** Parse #rgb/#rrggbb/#rrggbbaa to [r,g,b] (alpha dropped — palette colors are opaque). */
function rgb(hex: string): [number, number, number] {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

const toHex = (c: [number, number, number]): string =>
  "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");

/** Linear mix of two hex colors: t=0 → a, t=1 → b. Literal-hex output so the
 *  palette needs no CSS color-mix() support in SVG fills. */
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return toHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

/**
 * Derive a categorical chart palette from the brand tokens — no schema
 * extension needed. The ramp is anchored on the accent and the neutral text
 * colors so it inherits the brand's character in both directions: a chromatic
 * accent yields a tinted ramp; a graphite accent (e.g. monochrome brands)
 * yields the restrained grayscale ramp such brands use in their own charts.
 * Series order: strongest first (recharts assigns colors in series order).
 */
export function brandToChartPalette(brand: BrandTokens): string[] {
  const { accent, text, mutedText, surface } = brand;
  const palette = [
    accent, // 1: the brand color, full strength
    mix(accent, surface, 0.45), // 2: softened accent
    mix(text, surface, 0.35), // 3: strong neutral
    mutedText, // 4: muted neutral
    mix(accent, text, 0.5), // 5: deep accent-neutral blend
    mix(mutedText, surface, 0.45), // 6: light neutral
  ];
  // Dedupe while preserving order (extreme brands can collapse two stops —
  // e.g. accent === text); nudge any collision toward surface instead of
  // dropping it so charts always have 6 distinguishable series colors.
  const seen = new Set<string>();
  return palette.map((c) => {
    let out = c.toLowerCase();
    let t = 0.15;
    while (seen.has(out) && t < 1) {
      out = mix(out, surface, t).toLowerCase();
      t += 0.15;
    }
    seen.add(out);
    return out;
  });
}
