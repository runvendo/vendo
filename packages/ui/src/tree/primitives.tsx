import type { ComponentType, CSSProperties, PropsWithChildren } from "react";
import { BRANDED_COMPONENTS } from "./branded.js";

// gap is a number of pixels only (the prewired schema and wire compiler both
// pin it to number); a string here was never emitted by generation and only
// widened the contract.
type GapProps = PropsWithChildren<{ gap?: number }>;

const spacing = (value: number | undefined, fallback: string): string =>
  value === undefined ? `${fallback}` : `${value}px`;

/** 01-core §8; 08-ui §5 */
export function Stack({ gap, children }: GapProps) {
  return (
    <div
      data-primitive="Stack"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: spacing(gap, "var(--vendo-space-small, 10px)"),
      }}
    >
      {children}
    </div>
  );
}

/** 01-core §8; 08-ui §5 */
export function Row({ gap, children }: GapProps) {
  return (
    <div
      data-primitive="Row"
      style={{
        display: "flex",
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: spacing(gap, "var(--vendo-space-small, 10px)"),
      }}
    >
      {children}
    </div>
  );
}

/** 01-core §8; 08-ui §5 */
export function Grid({ columns = 2, children }: PropsWithChildren<{ columns?: number }>) {
  const safeColumns = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 2;
  return (
    <div
      data-primitive="Grid"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${safeColumns}, minmax(0, 1fr))`,
        alignItems: "stretch",
        gap: "var(--vendo-space-small, 10px)",
      }}
    >
      {children}
    </div>
  );
}

/** 01-core §8; 08-ui §5 */
export function Text(props: PropsWithChildren<{
  text?: unknown;
  variant?: "body" | "heading" | "caption";
}>) {
  const variant = props.variant ?? "body";
  const style: CSSProperties = {
    color: variant === "caption"
      ? "var(--vendo-color-muted, #6b6b76)"
      : "var(--vendo-color-text, #1a1a1e)",
    fontFamily: variant === "heading"
      ? "var(--vendo-heading-family, var(--vendo-font-family, system-ui, sans-serif))"
      : "var(--vendo-font-family, system-ui, sans-serif)",
    fontSize: variant === "caption"
      ? "var(--vendo-font-size-caption, 12.5px)"
      : "var(--vendo-font-size, 15px)",
    fontWeight: variant === "heading" ? 650 : 400,
    letterSpacing: "-0.011em",
    lineHeight: variant === "heading" ? 1.3 : 1.5,
    margin: 0,
  };
  const content = props.text === undefined ? props.children : String(props.text);
  return variant === "heading"
    ? <h3 data-primitive="Text" data-variant={variant} style={style}>{content}</h3>
    : <span data-primitive="Text" data-variant={variant} style={style}>{content}</span>;
}

/** 01-core §8; 08-ui §5 */
export function Skeleton(props: { width?: string | number; height?: string | number }) {
  return (
    <span
      className="fl-glass fl-glass-shimmer"
      data-primitive="Skeleton"
      aria-hidden="true"
      style={{
        display: "block",
        width: props.width ?? "100%",
        height: props.height ?? "var(--vendo-skeleton-height, 16px)",
        minHeight: props.height ?? "var(--vendo-skeleton-height, 16px)",
        background: `linear-gradient(100deg,
          color-mix(in srgb, var(--vendo-color-accent, #2f5af5) 10%, transparent) 30%,
          color-mix(in srgb, var(--vendo-color-accent, #2f5af5) 22%, transparent) 50%,
          color-mix(in srgb, var(--vendo-color-accent, #2f5af5) 10%, transparent) 70%)`,
        backgroundSize: "200% 100%",
        borderRadius: "var(--vendo-radius-medium, 10px)",
      }}
    />
  );
}

/** 01-core §8; 08-ui §5 */
export function Surface({ children }: PropsWithChildren) {
  return (
    <section
      className="fl-glass"
      data-primitive="Surface"
      style={{
        color: "var(--vendo-color-text, #1a1a1e)",
        background: "color-mix(in srgb, var(--vendo-color-surface, #f7f7f8) 82%, transparent)",
        border: "1px solid color-mix(in srgb, var(--vendo-color-border, #e3e3e8) 72%, rgba(255, 255, 255, 0.65))",
        borderRadius: "var(--vendo-radius-medium, 12px)",
        boxShadow: `0 4px 24px color-mix(in srgb, var(--vendo-color-text, #1a1a1e) 6%, transparent),
          inset 0 1px 0 rgba(255, 255, 255, 0.65)`,
        WebkitBackdropFilter: "blur(14px) saturate(160%)",
        backdropFilter: "blur(14px) saturate(160%)",
        padding: "var(--vendo-space-medium, 15px) var(--vendo-space-large, 16px)",
      }}
    >
      {children}
    </section>
  );
}

/** 01-core §8; 08-ui §5 */
export function Divider() {
  return (
    <hr
      data-primitive="Divider"
      aria-hidden="true"
      style={{
        width: "100%",
        margin: 0,
        border: 0,
        borderTop: "1px solid var(--vendo-color-border, rgba(20, 21, 26, 0.09))",
      }}
    />
  );
}

/** Reserved prewired component table from 01-core §8. */
export const PREWIRED_COMPONENTS: Readonly<Record<string, ComponentType<Record<string, unknown>>>> = {
  Stack: Stack as ComponentType<Record<string, unknown>>,
  Row: Row as ComponentType<Record<string, unknown>>,
  Grid: Grid as ComponentType<Record<string, unknown>>,
  Text: Text as ComponentType<Record<string, unknown>>,
  Skeleton: Skeleton as ComponentType<Record<string, unknown>>,
  Surface: Surface as ComponentType<Record<string, unknown>>,
  Divider: Divider as ComponentType<Record<string, unknown>>,
  ...BRANDED_COMPONENTS as unknown as Record<string, ComponentType<Record<string, unknown>>>,
};
