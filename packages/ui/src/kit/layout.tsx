/** Layout tier — themed containers (W2 §The Kit). */
import type { CSSProperties, PropsWithChildren } from "react";
import { densityVars, font, resolveTone, t, toneColor, type KitDensity, type KitTone } from "./tokens.js";

const gapVar = (gap: number | undefined): string =>
  gap === undefined ? "var(--vendo-density-content-gap, 10px)" : `${gap}px`;

/** A toned container's rule. Neutral keeps the plain border rather than the
 *  tone's foreground: a card is a region, not a pill. */
const borderColor = (tone: KitTone | undefined): string => {
  const resolved = resolveTone(tone, "neutral");
  return resolved === "neutral" ? t.border : toneColor(resolved);
};

export interface StackProps {
  gap?: number;
  density?: KitDensity;
}

/** Vertical flow. */
export function Stack({ gap, density, children }: PropsWithChildren<StackProps>) {
  return (
    <div
      data-kit="Stack"
      style={{ ...densityVars(density), display: "flex", flexDirection: "column", alignItems: "stretch", gap: gapVar(gap) }}
    >
      {children}
    </div>
  );
}

export interface RowProps {
  gap?: number;
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
  density?: KitDensity;
}

const alignMap: Record<string, CSSProperties["alignItems"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
};
const justifyMap: Record<string, CSSProperties["justifyContent"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
};

/** Horizontal flow. */
export function Row({ gap, align = "center", justify = "start", wrap = true, density, children }: PropsWithChildren<RowProps>) {
  return (
    <div
      data-kit="Row"
      style={{
        ...densityVars(density),
        display: "flex",
        flexDirection: "row",
        flexWrap: wrap ? "wrap" : "nowrap",
        alignItems: alignMap[align],
        justifyContent: justifyMap[justify],
        gap: gapVar(gap),
      }}
    >
      {children}
    </div>
  );
}

export interface GridProps {
  columns?: number;
  /** Narrowest a cell may get, in px. Wins over `columns`. */
  minChildWidth?: number;
  gap?: number;
  density?: KitDensity;
}

/** Equal-width columns. */
export function Grid({ columns = 2, minChildWidth = 0, gap, density, children }: PropsWithChildren<GridProps>) {
  const safe = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 2;
  // A fixed count CLIPS its cells once the screen is narrower than the count
  // needs; auto-fit wraps them instead. The inner `min()` is what keeps the last
  // single column from overflowing a surface narrower than the floor itself.
  const template =
    minChildWidth > 0
      ? `repeat(auto-fit, minmax(min(${Math.floor(minChildWidth)}px, 100%), 1fr))`
      : `repeat(${safe}, minmax(0, 1fr))`;
  return (
    <div
      data-kit="Grid"
      style={{
        ...densityVars(density),
        display: "grid",
        gridTemplateColumns: template,
        alignItems: "stretch",
        gap: gapVar(gap),
      }}
    >
      {children}
    </div>
  );
}

export interface SurfaceProps {
  title?: string;
  tone?: KitTone;
  density?: KitDensity;
}

/** A bordered, elevated container; optional title. */
export function Surface({ title, tone, density, children }: PropsWithChildren<SurfaceProps>) {
  return (
    <section
      data-kit="Surface"
      data-tone={resolveTone(tone, "neutral")}
      style={{
        ...font,
        ...densityVars(density),
        display: "flex",
        flexDirection: "column",
        gap: "var(--vendo-density-content-gap, 10px)",
        border: `1px solid ${borderColor(tone)}`,
        borderRadius: t.radiusMedium,
        background: t.surface,
        boxShadow: `0 4px 24px color-mix(in srgb, ${t.text} 6%, transparent)`,
        padding: "var(--vendo-density-card-padding, 16px)",
      }}
    >
      {title ? (
        <div
          style={{
            fontFamily: t.headingFamily,
            fontSize: "calc(var(--vendo-font-size, 15px) * 1.05)",
            fontWeight: 650,
            letterSpacing: "-0.015em",
          }}
        >
          {title}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export interface CardProps {
  title?: string;
  description?: string;
  tone?: KitTone;
  density?: KitDensity;
}

/** A titled content block; Surface is the untitled/plain container. */
export function Card({ title, description, tone, density, children }: PropsWithChildren<CardProps>) {
  return (
    <article
      data-kit="Card"
      data-tone={resolveTone(tone, "neutral")}
      style={{
        ...font,
        ...densityVars(density),
        display: "flex",
        flexDirection: "column",
        gap: "var(--vendo-density-content-gap, 10px)",
        border: `1px solid ${borderColor(tone)}`,
        borderRadius: t.radiusLarge,
        background: t.surface,
        boxShadow: `0 8px 24px color-mix(in srgb, ${t.text} 7%, transparent)`,
        padding: "var(--vendo-density-card-padding, 16px)",
      }}
    >
      {title ? (
        <div
          style={{
            fontFamily: t.headingFamily,
            fontSize: "calc(var(--vendo-font-size, 15px) * 1.08)",
            fontWeight: 650,
            letterSpacing: "-0.015em",
            lineHeight: 1.3,
          }}
        >
          {title}
        </div>
      ) : null}
      {description ? (
        <div style={{ color: t.muted, fontSize: "0.9em", lineHeight: 1.45 }}>{description}</div>
      ) : null}
      {children}
    </article>
  );
}

/** A horizontal rule. */
export function Divider() {
  return (
    <hr
      data-kit="Divider"
      aria-hidden="true"
      style={{ width: "100%", margin: 0, border: 0, borderTop: `1px solid ${t.border}` }}
    />
  );
}
