/** Avatar — initials in a tint derived from the name (W2 §The Kit). No image:
 *  a host's avatar URL is not something the Kit fetches. */
import type { CSSProperties } from "react";
import { font, seriesColor, t } from "../tokens.js";

export interface AvatarProps {
  /** The person or account this stands for; both the initials and the tint
   *  come from it, so the same name is the same disc everywhere. */
  name?: string;
  size?: "sm" | "md" | "lg";
}

const SIZES = { sm: 24, md: 32, lg: 44 } as const;

/** Adjacent avatars in a Row overlap into a stack. It is a SIBLING relation, so
 *  no inline style can say it; React hoists and de-duplicates this one rule by
 *  `href`, however many avatars ask for it. The pull cancels the gap the Row
 *  resolved — default or explicit — first, then bites into the disc. */
const STACK_CSS =
  '[data-kit="Row"] > [data-kit="Avatar"] + [data-kit="Avatar"]' +
  "{margin-inline-start:calc(var(--vendo-kit-row-gap, 10px) * -1 - var(--vendo-kit-avatar-size) * 0.32)}";

/** First letter of each of the first two words — "Ada Lovelace" → "AL". */
function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => [...word][0]?.toUpperCase() ?? "")
    .join("");
}

/** Same name, same color, on every render and every machine: a sum over the
 *  code points, indexed into the accent ramp the charts already speak. */
function tint(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return seriesColor(hash);
}

export function Avatar({ name = "", size = "md" }: AvatarProps) {
  const px = SIZES[size] ?? SIZES.md;
  const seed = tint(name);
  return (
    <>
      <style href="vendo-kit-avatar" precedence="default">{STACK_CSS}</style>
      <span
        data-kit="Avatar"
        data-size={size}
        {...(name === "" ? { "aria-hidden": true } : { role: "img", "aria-label": name })}
        style={{
          ...font,
          "--vendo-kit-avatar-size": `${px}px`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          width: px,
          height: px,
          borderRadius: "50%",
          background: `color-mix(in srgb, ${seed} 18%, ${t.surface})`,
          color: `color-mix(in srgb, ${seed} 80%, ${t.text})`,
          // The ring is what keeps a stacked disc readable against the one
          // behind it, and reads as nothing on a plain surface.
          boxShadow: `0 0 0 calc(var(--vendo-border-width, 1px) * 2) ${t.surface}`,
          fontSize: Math.round(px * 0.38),
          fontWeight: 650,
          letterSpacing: "0.02em",
          lineHeight: 1,
          userSelect: "none",
        } as CSSProperties}
      >
        {initials(name)}
      </span>
    </>
  );
}
