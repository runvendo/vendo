/** Badge — small status label using theme tones (W2 §The Kit). */
import type { PropsWithChildren } from "react";
import { EnumBadge, type EnumTone } from "../values.js";

export interface BadgeProps {
  label?: string;
  tone?: EnumTone;
}

/**
 * A literal status pill. For enum data fields prefer `EnumBadge` (it humanizes
 * and tone-maps the raw value); `Badge` is for a copy label the model writes.
 */
export function Badge({ label, tone = "neutral", children }: PropsWithChildren<BadgeProps>) {
  const text = label ?? (typeof children === "string" ? children : "");
  // Reuse EnumBadge's tone styling with an explicit label (no humanization).
  return <EnumBadge value={text} labels={{ [text]: text }} tone={tone} />;
}
