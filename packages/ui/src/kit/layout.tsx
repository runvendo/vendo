/** Layout tier — themed containers (W2 §The Kit). */
import { Children, useEffect, useRef, useState, type CSSProperties, type PropsWithChildren, type ReactNode } from "react";
import { densityVars, font, hairline, microLabel, resolveTone, t, toneColor, type KitDensity, type KitStyled, type KitTone } from "./tokens.js";

const gapVar = (gap: number | undefined): string =>
  gap === undefined ? "var(--vendo-density-content-gap, 10px)" : `${gap}px`;

/**
 * `grow` — "as a child of a Row/Grid/Stack, take the remaining space". The
 * shared adjective the raw `<div style={{flex:1}}>` escapes were reaching for:
 * 17 of them counted, every one written because the Kit's containers could size
 * their children but a child could not claim what was left, so a search box
 * beside a button, or a chart beside a legend, dropped out of the Kit entirely.
 *
 * `minWidth: 0` rides along because those escapes wanted a child that SHRINKS
 * as well as grows. A flex child keeps its content's intrinsic width by default,
 * so a grown pane holding a wide table pushes its sibling off the row instead of
 * scrolling inside its own box — the same floor SplitPane's tracks need, for the
 * same reason.
 */
const growStyle = (grow: boolean | number | undefined): CSSProperties =>
  grow === undefined || grow === false ? {} : { flexGrow: grow === true ? 1 : grow, minWidth: 0 };

/** A toned container's rule. Neutral keeps the plain border rather than the
 *  tone's foreground: a card is a region, not a pill. */
const borderColor = (tone: KitTone | undefined): string => {
  const resolved = resolveTone(tone, "neutral");
  return resolved === "neutral" ? t.border : toneColor(resolved);
};

export interface StackProps extends KitStyled {
  gap?: number;
  density?: KitDensity;
  grow?: boolean | number;
}

/** Vertical flow. */
export function Stack({ gap, density, grow, style, children }: PropsWithChildren<StackProps>) {
  return (
    <div
      data-kit="Stack"
      style={{ ...densityVars(density), display: "flex", flexDirection: "column", alignItems: "stretch", gap: gapVar(gap), ...growStyle(grow), ...style }}
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
  grow?: boolean | number;
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
export function Row({ gap, align = "center", justify = "start", wrap = true, density, grow, style, children }: PropsWithChildren<RowProps>) {
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
        ...growStyle(grow),
        ...style,
      } as CSSProperties}
    >
      {children}
    </div>
  );
}

export interface GridProps extends KitStyled {
  /** A FIXED column count, kept at every width — which is what CLIPS on a narrow
   *  screen. Name it only where the layout genuinely needs the count; left out,
   *  the cells wrap. */
  columns?: number;
  /** Narrowest a cell may get, in px. Wins over `columns`, and
   *  {@link BARE_MIN_CHILD_WIDTH} is what a bare Grid uses. */
  minChildWidth?: number;
  gap?: number;
  density?: KitDensity;
  grow?: boolean | number;
}

/** The floor a Grid nobody sized wraps at, in px — the width screens themselves
 *  write when they name one (586 of the corpus's 632 `minChildWidth` values), and
 *  the width a Stat tile reads at. */
const BARE_MIN_CHILD_WIDTH = 160;

/** Equal-width columns, wrapping to fit. */
export function Grid({ columns, minChildWidth, gap, density, grow, style, children }: PropsWithChildren<GridProps>) {
  const safe = typeof columns === "number" && Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 2;
  // A fixed count CLIPS its cells once the screen is narrower than the count
  // needs, so it is what a Grid does only where the screen ASKED for a count:
  // bare, it auto-fits and wraps. Two fixed columns was a default the Kit
  // inflicted on itself — every grid of tiles clipped below ~480px, and screens
  // learned to write `minChildWidth` past it rather than trust the bare form.
  // The inner `min()` is what keeps the last single column from overflowing a
  // surface narrower than the floor itself.
  const floor = minChildWidth ?? (columns === undefined ? BARE_MIN_CHILD_WIDTH : 0);
  const template =
    floor > 0
      ? `repeat(auto-fit, minmax(min(${Math.floor(floor)}px, 100%), 1fr))`
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
        ...growStyle(grow),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export interface SplitPaneProps extends KitStyled {
  /** The first pane's width: a CSS length ("40%", "18rem", "280px"), or px as a
   *  bare number. A number below 1 is still read as a share of the split. */
  size?: number | string;
}

/**
 * Below this width, in px, the pair STACKS — because below this it is not a pair.
 * The default first pane is 320px, and the second needs roughly 200 before its
 * content is a column of wrapped fragments rather than a detail view. So 520 is
 * where side-by-side stops being the layout the person described, and the
 * arrangement that keeps their content is one pane above the other.
 */
const STACK_BELOW = 520;

/**
 * Two panes side by side, at any width.
 *
 * The one arrangement the Kit could not express: Row and Grid both WRAP, which
 * is right for stats and buttons and wrong for a list beside the thing it opens
 * — the pair a screen is asked for whenever the ask says "and". Asked for one on
 * a narrow frame, a screen wrote raw CSS instead, or stacked the two and lost
 * the layout the person described.
 *
 * So this one never wraps: the panes are grid TRACKS, and an extra child becomes
 * another column rather than a second row. Each track is floored at 0 — the
 * `minmax(0, …)` CodeBlock's block needs for the same reason — so a long line or
 * a wide table inside one pane scrolls in ITS OWN pane instead of pushing the
 * other one off the frame.
 *
 * The one width where side-by-side is the wrong answer is a frame too narrow to
 * hold both: there the second pane was squeezed to a sliver and CLIPPED, so the
 * detail half of "a list beside the thing it opens" simply was not on screen.
 * Under {@link STACK_BELOW} the panes flow as rows instead — the same content,
 * one above the other, still each in its own scrolling box.
 */
export function SplitPane({ size = 320, style, children }: PropsWithChildren<SplitPaneProps>) {
  // A string is a CSS length verbatim — "40%", "18rem", "280px" — which is the
  // one spelling the spec now teaches. A number at or above 1 is px, and below 1
  // it is a share of the split (0.4 → 40%): only TOLERATED, because stored
  // screens carry the float and nothing else can be meant by it — a pane 0.4
  // pixels wide is not a layout.
  const first =
    typeof size === "string"
      ? size
      : size > 0 && size < 1
        ? `${size * 100}%`
        : `${Math.max(0, Math.floor(size))}px`;
  const root = useRef<HTMLDivElement | null>(null);
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    const node = root.current;
    // No ResizeObserver (SSR, jsdom): nothing is measured, so nothing stacks and
    // the pair renders exactly as it always did. The trigger is the measurement,
    // the way DataTable's fold reads its own width — the Kit paints inside a host
    // page it does not control, so a media query would answer for the WINDOW
    // while this pair sits in whatever column the host gave it.
    if (node === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setStacked(node.clientWidth < STACK_BELOW);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      data-kit="SplitPane"
      ref={root}
      data-stacked={stacked ? "" : undefined}
      style={{
        display: "grid",
        // Stacked, the panes are ROWS of one full-width track: keeping the two
        // columns is exactly what clipped the second one, and keeping `column`
        // auto-flow would hand every extra child an implicit column again.
        gridTemplateColumns: stacked ? "minmax(0, 1fr)" : `minmax(0, ${first}) minmax(0, 1fr)`,
        gridAutoFlow: stacked ? "row" : "column",
        gridAutoColumns: stacked ? undefined : "minmax(0, 1fr)",
        alignItems: "stretch",
        gap: "var(--vendo-density-content-gap, 10px)",
        minHeight: 0,
        ...style,
      }}
    >
      {Children.map(children, (pane) => (
        // Each pane owns its overflow, so the tall one scrolls while the short
        // one stays put — and neither can widen the other.
        <div style={{ minWidth: 0, minHeight: 0, overflow: "auto" }}>{pane}</div>
      ))}
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
  grow?: boolean | number;
}

/** A bordered, elevated container; optional title. */
export function Surface({ title, tone, density, header, footer, grow, style, children }: PropsWithChildren<SurfaceProps>) {
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
        ...growStyle(grow),
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
  /** A subtitle under the title — a string, or Kit marks where the value needs
   *  their type (a mono `branch·sha` pair rather than hand-rolled text). */
  description?: ReactNode;
  tone?: KitTone;
  density?: KitDensity;
  /** Kit elements along the top edge, beside the title. */
  header?: ReactNode;
  /** Kit elements under the content — the buttons a card ends with. */
  footer?: ReactNode;
  grow?: boolean | number;
}

/** A titled content block; Surface is the untitled/plain container. */
export function Card({ title, description, tone, density, header, footer, grow, style, children }: PropsWithChildren<CardProps>) {
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
        ...growStyle(grow),
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
