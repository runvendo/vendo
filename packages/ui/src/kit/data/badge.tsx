/** Badge — small status label using theme tones (W2 §The Kit). */
import type { PropsWithChildren } from "react";
import { applyFormat } from "../format.js";
import { useFieldValue } from "../row.js";
import { resolveTone, type KitStyled } from "../tokens.js";
import { EnumBadge, type EnumTone } from "../values.js";

export interface BadgeProps extends KitStyled {
  label?: string;
  tone?: EnumTone;
  /** Inside a cell slot: the row field this label comes from. */
  field?: string;
}

/**
 * A literal status pill. For enum data fields prefer `EnumBadge` (it humanizes
 * and tone-maps the raw value); `Badge` is for a copy label the model writes.
 */
export function Badge({ label, tone, field, style, children }: PropsWithChildren<BadgeProps>) {
  const own = label ?? (typeof children === "string" ? children : "");
  // A row field holds anything; `applyFormat` is the tier's total coercion.
  const text = applyFormat(useFieldValue(field, own), "text") ?? "";
  // Reuse EnumBadge's tone styling with an explicit label (no humanization).
  // The pill EnumBadge paints IS this component's root, so `style` rides along.
  return <EnumBadge value={text} labels={{ [text]: text }} tone={resolveTone(tone)} style={style} />;
}
