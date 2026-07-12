import type { ComponentType, CSSProperties, PropsWithChildren } from "react";

type GapProps = PropsWithChildren<{ gap?: string | number }>;

const spacing = (value: string | number | undefined, fallback: string): string => {
  if (typeof value === "number") return `${value}px`;
  return value ?? fallback;
};

/** 01-core §8; 08-ui §5 */
export function Stack({ gap, children }: GapProps) {
  return (
    <div
      data-primitive="Stack"
      style={{ display: "flex", flexDirection: "column", gap: spacing(gap, "var(--vendo-space-small, 8px)") }}
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
      style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: spacing(gap, "var(--vendo-space-small, 8px)") }}
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
        gap: "var(--vendo-space-small, 8px)",
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
      ? "var(--vendo-font-size-caption, 12px)"
      : "var(--vendo-font-size, 15px)",
    fontWeight: variant === "heading" ? 600 : 400,
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
      data-primitive="Skeleton"
      aria-hidden="true"
      style={{
        display: "block",
        width: props.width ?? "100%",
        minHeight: props.height ?? "var(--vendo-skeleton-height, 16px)",
        background: "var(--vendo-color-border, #e3e3e8)",
        borderRadius: "var(--vendo-radius-small, 6px)",
      }}
    />
  );
}

/** 01-core §8; 08-ui §5 */
export function Surface({ children }: PropsWithChildren) {
  return (
    <section
      data-primitive="Surface"
      style={{
        color: "var(--vendo-color-text, #1a1a1e)",
        background: "var(--vendo-color-surface, #f7f7f8)",
        border: "1px solid var(--vendo-color-border, #e3e3e8)",
        borderRadius: "var(--vendo-radius-medium, 10px)",
        padding: "var(--vendo-space-medium, 12px)",
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
      style={{ width: "100%", border: 0, borderTop: "1px solid var(--vendo-color-border, #e3e3e8)" }}
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
};
