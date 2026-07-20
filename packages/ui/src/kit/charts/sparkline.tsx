/** Sparkline — a compact inline trend, recharts Area internals (W2 §The Kit). */
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { seriesColor } from "../tokens.js";
import { font, t } from "../tokens.js";
import { sanitizeNumbers } from "./sanitize.js";

export interface SparklineProps {
  /** A list of numbers, or rows with a `valueKey`. */
  data: Array<number | Record<string, unknown>>;
  /** Field to read when `data` holds objects. */
  valueKey?: string;
  height?: number;
  /** Placeholder shown when there is nothing renderable. */
  emptyState?: string;
}

export function Sparkline({ data, valueKey = "value", height = 40, emptyState = "—" }: SparklineProps) {
  const raw = data.map((d) => (typeof d === "number" ? d : (d[valueKey] as number)));
  const clean = sanitizeNumbers(raw);
  if (clean.length < 2) {
    return (
      <span data-kit="Sparkline" style={{ ...font, color: t.muted, fontSize: "0.9em" }}>
        {emptyState}
      </span>
    );
  }
  const points = clean.map((v, i) => ({ i, v }));
  return (
    <div data-kit="Sparkline" style={{ width: "100%", height, minHeight: height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <defs>
            <linearGradient id="vendo-spark-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={seriesColor(0)} stopOpacity={0.25} />
              <stop offset="100%" stopColor={seriesColor(0)} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={seriesColor(0)}
            strokeWidth={1.6}
            fill="url(#vendo-spark-fill)"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
