/** Layout tier — themed containers (W2 §The Kit). */
import type { CSSProperties, PropsWithChildren, ReactNode } from "react";
import { densityVars, font, hairline, microLabel, resolveTone, t, toneColor, type KitDensity, type KitStyled, type KitTone } from "./tokens.js";

const gapVar = (gap: number | undefined): string =>
  gap === undefined ? "var(--vendo-density-content-gap, 10px)" : `${gap}px`;

/** A toned container's rule. Neutral keeps the plain border rather than the
 *  tone's foreground: a card is a region, not a pill. */
const borderColor = (tone: KitTone | undefined): string => {
  const resolved = resolveTone(tone, "neutral");
  return resolved === "neutral" ? t.border : toneColor(resolved);
};

export interface StackProps extends KitStyled {
  gap?: number;
  density?: KitDensity;
}

/** Vertical flow. */
export function Stack({ gap, density, style, children }: PropsWithChildren<StackProps>) {
  return (
    <div
      data-kit="Stack"
      style={{ ...densityVars(density), display: "flex", flexDirection: "column", alignItems: "stretch", gap: gapVar(gap), ...style }}
    >
      {children}
    </div>
  );
}

export interface RowProps extends KitStyled {
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
export function Row({ gap, align = "center", justify = "start", wrap = true, density, style, children }: PropsWithChildren<RowProps>) {
  // Avatar's stack rule pulls its sibling back by the row's gap, and a numeric
  // `gap` never reaches the density variable — so the row publishes whichever
  // gap it resolved.
  const resolved = gapVar(gap);
  return (
    <div
      data-kit="Row"
      style={{
        ...densityVars(density),
        "--vendo-kit-row-gap": resolved,
        display: "flex",
        flexDirection: "row",
        flexWrap: wrap ? "wrap" : "nowrap",
        alignItems: alignMap[align],
        justifyContent: justifyMap[justify],
        gap: resolved,
        ...style,
      } as CSSProperties}
    >
      {children}
    </div>
  );
}

export interface GridProps extends KitStyled {
  columns?: number;
  /** Narrowest a cell may get, in px. Wins over `columns`. */
  minChildWidth?: number;
  gap?: number;
  density?: KitDensity;
}

/** Equal-width columns. */
export function Grid({ columns = 2, minChildWidth = 0, gap, density, style, children }: PropsWithChildren<GridProps>) {
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
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** The two rows a container's slots ride in — the title's, which `header`
 *  shares, and the one under the content that `footer` fills. The same two a
 *  dialog draws (overlay/dialog.tsx). */
const headerRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "var(--vendo-density-inline-gap, 7px)",
};
const footerRow: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--vendo-density-inline-gap, 7px)",
};

export interface SurfaceProps extends KitStyled {
  title?: string;
  tone?: KitTone;
  density?: KitDensity;
  /** Kit elements along the top edge, beside the title. */
  header?: ReactNode;
  /** Kit elements under the content — the buttons a region ends with. */
  footer?: ReactNode;
}

/** A bordered, elevated container; optional title. */
export function Surface({ title, tone, density, header, footer, style, children }: PropsWithChildren<SurfaceProps>) {
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
        border: `${t.borderWidth} solid ${borderColor(tone)}`,
        borderRadius: t.radiusMedium,
        background: t.surface,
        padding: "var(--vendo-density-card-padding, 16px)",
        ...style,
      }}
    >
      {title || header ? (
        <div style={headerRow}>
          <div
            style={{
              fontFamily: t.headingFamily,
              fontSize: "calc(var(--vendo-font-size, 15px) * 1.05)",
              fontWeight: t.weightEmphasis,
              lineHeight: t.lineHeightHeading,
            }}
          >
            {title}
          </div>
          {header}
        </div>
      ) : null}
      {children}
      {footer === undefined ? null : <div style={footerRow}>{footer}</div>}
    </section>
  );
}

export interface CardProps extends KitStyled {
  title?: string;
  description?: string;
  tone?: KitTone;
  density?: KitDensity;
  /** Kit elements along the top edge, beside the title. */
  header?: ReactNode;
  /** Kit elements under the content — the buttons a card ends with. */
  footer?: ReactNode;
}

/** A titled content block; Surface is the untitled/plain container. */
export function Card({ title, description, tone, density, header, footer, style, children }: PropsWithChildren<CardProps>) {
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
        border: `${t.borderWidth} solid ${borderColor(tone)}`,
        borderRadius: t.radiusLarge,
        background: t.surface,
        padding: "var(--vendo-density-card-padding, 16px)",
        ...style,
      }}
    >
      {title || header ? (
        <div style={headerRow}>
          <div
            style={{
              fontFamily: t.headingFamily,
              fontSize: "calc(var(--vendo-font-size, 15px) * 1.08)",
              fontWeight: t.weightEmphasis,
              lineHeight: t.lineHeightHeading,
            }}
          >
            {title}
          </div>
          {header}
        </div>
      ) : null}
      {description ? (
        <div style={{ color: t.muted, fontSize: "0.9em" }}>{description}</div>
      ) : null}
      {children}
      {footer === undefined ? null : <div style={footerRow}>{footer}</div>}
    </article>
  );
}

export interface DividerProps extends KitStyled {
  /** A Kit mark centred in the rule, which then reads as a section break
   *  rather than as decoration. */
  label?: ReactNode;
}

/** A horizontal rule. */
export function Divider({ label, style }: DividerProps) {
  // An `<hr>` is void, so a labelled rule is two rules around the label — and it
  // carries meaning, so it is NOT hidden from the reading order the way the
  // plain one is.
  if (label === undefined) {
    return (
      <hr
        data-kit="Divider"
        aria-hidden="true"
        style={{ width: "100%", margin: 0, border: 0, borderTop: hairline, ...style }}
      />
    );
  }
  return (
    <div
      data-kit="Divider"
      role="separator"
      style={{ ...font, display: "flex", alignItems: "center", gap: "var(--vendo-density-inline-gap, 7px)", width: "100%", ...style }}
    >
      <span style={{ flex: 1, borderTop: hairline }} />
      <span style={microLabel}>{label}</span>
      <span style={{ flex: 1, borderTop: hairline }} />
    </div>
  );
}
