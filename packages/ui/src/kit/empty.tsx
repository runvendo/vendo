/**
 * The rendered "there is nothing here" (W2 §The Kit).
 *
 * An empty result is a FACT the screen states, not an absence it leaves on the
 * page: full-strength text because the sentence stands where the value would
 * stand, and a box sized to its own words — a chart-height frame holding one
 * muted line is the blank area that reads as broken. One implementation, so a
 * table, a card list and a chart all say it the same way.
 */
import type { ReactNode } from "react";
import { font, t } from "./tokens.js";

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div
      data-kit="EmptyNote"
      style={{
        ...font,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1px dashed ${t.border}`,
        borderRadius: t.radiusMedium,
        fontWeight: 600,
        padding: "var(--vendo-density-card-padding, 16px)",
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}
