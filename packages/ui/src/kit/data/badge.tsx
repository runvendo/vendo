/** Badge — small status label using theme tones (W2 §The Kit). */
import type { PropsWithChildren } from "react";
import { resolveTone, type KitStyled } from "../tokens.js";
import { EnumBadge, type EnumTone } from "../values.js";

export interface BadgeProps extends KitStyled {
  label?: string;
  tone?: EnumTone;
}

/**
 * A literal status pill. For enum data fields prefer `EnumBadge` (it humanizes
 * and tone-maps the raw value); `Badge` is for a copy label the model writes.
 */
export function Badge({ label, tone, style, children }: PropsWithChildren<BadgeProps>) {
  const text = label ?? (typeof children === "string" ? children : "");
  // Reuse EnumBadge's tone styling with an explicit label (no humanization).
  // The pill EnumBadge paints IS this component's root, so `style` rides along.
  return <EnumBadge value={text} labels={{ [text]: text }} tone={resolveTone(tone)} style={style} />;
}
