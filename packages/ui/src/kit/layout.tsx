/** Layout tier — themed containers (W2 §The Kit). */
import type { CSSProperties, PropsWithChildren } from "react";
import { font, t } from "./tokens.js";

const gapVar = (gap: number | undefined): string =>
  gap === undefined ? "var(--vendo-density-content-gap, 10px)" : `${gap}px`;

export interface StackProps {
  gap?: number;
}

/** Vertical flow. */
export function Stack({ gap, children }: PropsWithChildren<StackProps>) {
  return (
    <div
      data-kit="Stack"
      style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: gapVar(gap) }}
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
export function Row({ gap, align = "center", justify = "start", wrap = true, children }: PropsWithChildren<RowProps>) {
  return (
    <div
      data-kit="Row"
      style={{
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
  gap?: number;
}

/** Equal-width columns. */
export function Grid({ columns = 2, gap, children }: PropsWithChildren<GridProps>) {
  const safe = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 2;
  return (
    <div
      data-kit="Grid"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${safe}, minmax(0, 1fr))`,
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
}

/** A bordered, elevated container; optional title. */
export function Surface({ title, children }: PropsWithChildren<SurfaceProps>) {
  return (
    <section
      data-kit="Surface"
      style={{
        ...font,
        display: "flex",
        flexDirection: "column",
        gap: "var(--vendo-density-content-gap, 10px)",
        border: `1px solid ${t.border}`,
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
  tone?: "default" | "accent" | "danger";
}

/** A titled content block; Surface is the untitled/plain container. */
export function Card({ title, description, tone = "default", children }: PropsWithChildren<CardProps>) {
  const toneColor = tone === "accent" ? t.accent : tone === "danger" ? t.danger : t.border;
  return (
    <article
      data-kit="Card"
      data-tone={tone}
      style={{
        ...font,
        display: "flex",
        flexDirection: "column",
        gap: "var(--vendo-density-content-gap, 10px)",
        border: `1px solid ${toneColor}`,
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
