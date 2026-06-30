import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { timeOfDayClockSchema } from "./descriptor";

const SIZE = 320;
const C = SIZE / 2;
const RING = 116; // radius of the dot ring
const TICK_OUTER = 134;

/** Hour (0-24) → angle in radians, midnight at top, clockwise. */
function hourAngle(hour: number): number {
  return ((hour / 24) * 360 - 90) * (Math.PI / 180);
}
function polar(hour: number, r: number): [number, number] {
  const a = hourAngle(hour);
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}
/** SVG arc path along radius `r` from hour `h0` to hour `h1` (clockwise). */
function arcPath(h0: number, h1: number, r: number): string {
  const [x0, y0] = polar(h0, r);
  const [x1, y1] = polar(h1, r);
  const large = h1 - h0 > 12 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}
function dotRadius(amount: number): number {
  const r = 3 + Math.sqrt(Math.max(amount, 0)) * 0.95;
  return Math.max(3, Math.min(18, r));
}
function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

const HOUR_LABELS: { hour: number; text: string }[] = [
  { hour: 0, text: "12a" },
  { hour: 6, text: "6a" },
  { hour: 12, text: "12p" },
  { hour: 18, text: "6p" },
];

export const TimeOfDayClock = createPrewiredImpl(timeOfDayClockSchema, (p) => {
  const lateStart = p.lateNightStart ?? 0;
  const lateEnd = p.lateNightEnd ?? 5;
  const points = p.points ?? [];
  const highlighted = points.find((pt) => pt.highlight);

  return (
    <div
      style={{
        background: "var(--flowlet-surface, #fff)",
        border: "1px solid var(--flowlet-border, #e9e9e5)",
        borderRadius: "var(--flowlet-radius, 16px)",
        padding: 18,
        boxShadow: "var(--flowlet-shadow, 0 14px 38px rgba(27,30,37,.10))",
        color: "var(--flowlet-fg, #1b1e25)",
        font: "var(--flowlet-font, 500 14px/1.4 system-ui, sans-serif)",
      }}
    >
      {p.title ? (
        <div style={{ fontSize: 15, fontWeight: 650, letterSpacing: "-.01em" }}>{p.title}</div>
      ) : null}
      {p.subtitle ? (
        <div style={{ fontSize: 12.5, color: "var(--flowlet-fg-muted, #8a8c92)", marginTop: 2 }}>
          {p.subtitle}
        </div>
      ) : null}

      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width="100%"
        style={{ display: "block", maxWidth: 360, margin: "6px auto 0" }}
        role="img"
        aria-label={
          highlighted
            ? `Time-of-day spending. Standout: ${fmtMoney(highlighted.amount)}${
                highlighted.label ? ` at ${highlighted.label}` : ""
              }.`
            : "Time-of-day spending clock"
        }
      >
        {/* face */}
        <circle cx={C} cy={C} r={RING + 6} fill="none" stroke="var(--flowlet-border, #ececea)" strokeWidth={1} />
        <circle cx={C} cy={C} r={RING - 6} fill="none" stroke="var(--flowlet-border, #f1f1ee)" strokeWidth={1} />

        {/* late-night "asleep" band */}
        <path
          d={arcPath(lateStart, lateEnd, RING)}
          fill="none"
          stroke="var(--flowlet-accent, #2f6f4f)"
          strokeOpacity={0.16}
          strokeWidth={22}
          strokeLinecap="round"
        />
        <text
          {...(() => {
            const [x, y] = polar((lateStart + lateEnd) / 2, RING - 30);
            return { x, y };
          })()}
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ fontSize: 9, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase" }}
          fill="var(--flowlet-accent, #2f6f4f)"
          fillOpacity={0.7}
        >
          asleep
        </text>

        {/* hour ticks */}
        {Array.from({ length: 24 }).map((_, h) => {
          const major = h % 6 === 0;
          const [x1, y1] = polar(h, TICK_OUTER);
          const [x2, y2] = polar(h, major ? TICK_OUTER - 10 : TICK_OUTER - 5);
          return (
            <line
              key={h}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="var(--flowlet-fg-muted, #b9bac0)"
              strokeOpacity={major ? 0.7 : 0.35}
              strokeWidth={major ? 1.5 : 1}
            />
          );
        })}
        {HOUR_LABELS.map(({ hour, text }) => {
          const [x, y] = polar(hour, TICK_OUTER + 11);
          return (
            <text
              key={text}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ fontSize: 10, fontWeight: 600 }}
              fill="var(--flowlet-fg-muted, #8a8c92)"
            >
              {text}
            </text>
          );
        })}

        {/* spending dots */}
        {points.map((pt, i) => {
          const [x, y] = polar(pt.hour, RING);
          const r = dotRadius(pt.amount);
          if (pt.highlight) {
            return (
              <g key={i}>
                <circle cx={x} cy={y} r={r + 7} fill="var(--flowlet-accent, #2f6f4f)" fillOpacity={0.18} />
                <circle cx={x} cy={y} r={r} fill="var(--flowlet-accent, #2f6f4f)" stroke="#fff" strokeWidth={2} />
              </g>
            );
          }
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={r}
              fill="var(--flowlet-fg, #1b1e25)"
              fillOpacity={0.22}
            />
          );
        })}

        {/* center readout */}
        {highlighted ? (
          <>
            <text
              x={C}
              y={C - 8}
              textAnchor="middle"
              style={{ fontSize: 30, fontWeight: 750, letterSpacing: "-.02em" }}
              fill="var(--flowlet-fg, #1b1e25)"
            >
              {fmtMoney(highlighted.amount)}
            </text>
            <text
              x={C}
              y={C + 14}
              textAnchor="middle"
              style={{ fontSize: 11.5, fontWeight: 600 }}
              fill="var(--flowlet-fg-muted, #8a8c92)"
            >
              {highlighted.label ?? ""}
            </text>
          </>
        ) : null}
      </svg>

      {highlighted ? (
        <div
          style={{
            marginTop: 10,
            display: "flex",
            alignItems: "center",
            gap: 8,
            justifyContent: "center",
            fontSize: 12.5,
            color: "var(--flowlet-fg-muted, #8a8c92)",
          }}
        >
          <span style={{ width: 9, height: 9, borderRadius: 9, background: "var(--flowlet-accent, #2f6f4f)" }} />
          Peak spending hour:&nbsp;
          <strong style={{ color: "var(--flowlet-fg, #1b1e25)" }}>
            {(() => {
              const h = Math.floor(highlighted.hour) % 24;
              const m = Math.round((highlighted.hour - Math.floor(highlighted.hour)) * 60);
              const ampm = h < 12 ? "AM" : "PM";
              const hh = h % 12 === 0 ? 12 : h % 12;
              return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
            })()}
          </strong>
        </div>
      ) : null}
    </div>
  );
});
