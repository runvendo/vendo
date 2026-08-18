/** Sparkline — a compact inline trend, recharts Area internals (W2 §The Kit). */
import type { ComponentProps } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { font, resolveTone, seriesColor, t, toneColor, type KitStyled, type KitTone, type KitEngine, type KitRendered, given } from "../tokens.js";
import { sanitizeNumbers } from "./sanitize.js";

interface SparklineOwnProps extends KitStyled {
  /** A list of numbers, or rows with a `valueKey`. */
  data?: Array<number | Record<string, unknown>>;
  /** Field to read when `data` holds objects. */
  valueKey?: string;
  height?: number;
  /** Placeholder shown when there is nothing renderable. */
  emptyState?: string;
  /** Paints the line — a trend that is bad news is `danger`. */
  tone?: KitTone;
}

/** Plus any recharts `<Area>` prop, handed straight to the curve. It arrives
 *  AFTER the Kit's own defaults, so `stroke` wins, and BEFORE `dataKey`, which
 *  the component owns — an overridden one would plot a field that is not there. */
export type SparklineProps = SparklineOwnProps & KitEngine<ComponentProps<typeof Area>, SparklineOwnProps, "dataKey">;

export function Sparkline({ data, valueKey = "value", height = 40, emptyState = "—", tone, style, children, pending, ...engine }: SparklineProps & KitRendered) {
  // W3 — fail SOFT on missing data (a failed query resolves to undefined).
  const raw = (Array.isArray(data) ? data : []).map((d) =>
    typeof d === "number" ? d : (d as Record<string, unknown> | null)?.[valueKey] as number,
  );
  const clean = sanitizeNumbers(raw);
  if (clean.length < 2) {
    return (
      <span data-kit="Sparkline" style={{ ...font, color: t.muted, fontSize: "0.9em", ...style }}>
        {emptyState}
      </span>
    );
  }
  const points = clean.map((v, i) => ({ i, v }));
  const resolved = resolveTone(tone);
  const line = resolved === "neutral" ? seriesColor(0) : toneColor(resolved);
  // Per-tone gradient id: a document resolves `url(#id)` to the FIRST match, so
  // one shared id would paint every sparkline on the page in the first one's fill.
  const fillId = `vendo-spark-fill-${resolved}`;
  // The ratio is `ChartFrame`'s intrinsic-width trick (charts/sanitize.tsx) at
  // this form's own proportion: a parent that sizes to its content (the Kit's
  // `Row`) measures `width: 100%` as zero and recharts draws nothing, and a trend
  // strip transferred from its height as a SQUARE would be 40px of illegible
  // line. A parent with a real width still wins.
  return (
    <div data-kit="Sparkline" style={{ width: "100%", aspectRatio: "4 / 1", height, minHeight: height, ...style }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={line} stopOpacity={0.25} />
              <stop offset="100%" stopColor={line} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            stroke={line}
            strokeWidth={1.5}
            fill={`url(#${fillId})`}
            dot={false}
            isAnimationActive={false}
            {...given(engine)}
            dataKey="v"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
