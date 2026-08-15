/** Icon — one lucide glyph from the generated path data (W2 §The Kit). */
import { ICON_PATHS } from "./icons.gen.js";
import { resolveTone, toneColor, type KitTone } from "./tokens.js";

export interface IconProps {
  /** A lucide name in kebab-case, e.g. "arrow-up-right". */
  name?: string;
  /** Edge length in px. */
  size?: number;
  /** Paints the glyph — a `danger` icon is how a failed step reads red. */
  tone?: KitTone;
  /** What a screen reader should call it. Absent, the glyph is decorative. */
  label?: string;
}

/** A stroked glyph that inherits its color. `<Icon name="check-circle" tone="success"/>`. */
export function Icon({ name, size = 16, tone, label }: IconProps) {
  const markup = name !== undefined && Object.hasOwn(ICON_PATHS, name) ? ICON_PATHS[name] : undefined;
  // Generated code guesses names; an unmapped one leaves a gap, never a crash
  // and never a broken-glyph box (the Callout lesson, 2026-07-26).
  if (markup === undefined) return <span data-kit="Icon" data-kit-missing-icon={name ?? ""} />;
  const resolved = resolveTone(tone);
  return (
    <svg
      data-kit="Icon"
      data-icon={name}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        display: "inline-block",
        flexShrink: 0,
        verticalAlign: "text-bottom",
        color: resolved === "neutral" ? undefined : toneColor(resolved),
      }}
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
