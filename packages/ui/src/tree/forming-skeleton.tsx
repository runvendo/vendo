import type { CSSProperties } from "react";

export type FormShape = "slab" | "tiles" | "rows" | "pill" | "chart" | "control";

/**
 * The shimmer bar every silhouette below is built from. V4 (one component
 * family) took `Skeleton` off the component vocabulary and the public
 * `@vendoai/ui/tree` surface — a loading placeholder is renderer chrome, not
 * something a model names. It lives here, with its only two consumers (this
 * module and frames.tsx), and is NOT re-exported from tree/index.ts.
 *
 * `data-skeleton` is the stable hook tests select on (it replaced
 * `data-primitive="Skeleton"`, which died with the primitive family).
 */
export function Skeleton(props: { width?: string | number; height?: string | number }) {
  return (
    <span
      className="fl-glass fl-glass-shimmer"
      data-skeleton=""
      aria-hidden="true"
      style={{
        display: "block",
        width: props.width ?? "100%",
        height: props.height ?? "var(--vendo-skeleton-height, 16px)",
        minHeight: props.height ?? "var(--vendo-skeleton-height, 16px)",
        background: `linear-gradient(100deg,
          color-mix(in srgb, var(--vendo-color-accent, #111111) 10%, transparent) 30%,
          color-mix(in srgb, var(--vendo-color-accent, #111111) 22%, transparent) 50%,
          color-mix(in srgb, var(--vendo-color-accent, #111111) 10%, transparent) 70%)`,
        backgroundSize: "200% 100%",
        borderRadius: "var(--vendo-radius-medium, 10px)",
      }}
    />
  );
}

/**
 * Pick A (ui-lane-renderer, 2026-07-19) — the tree streams before generated
 * component SOURCES arrive, so a forming node's silhouette can only come from
 * what its name says the component is. Anything unrecognized keeps the
 * historical 72px slab, so the fallback is never worse than before.
 */
export function deriveFormShape(componentName: string): FormShape {
  // A plot is the tallest thing in an app; a 72px slab that becomes a 180px
  // chart is the layout jump the skeleton exists to prevent. Sparkline is
  // deliberately excluded — it is an inline mark, not a plot.
  if (/chart|graph|plot/i.test(componentName)) return "chart";
  // A control is a small left-aligned thing; a full-width slab where a button
  // lands reads as a broken section and then collapses when the real one lands.
  if (/button|submit|cta/i.test(componentName)) return "control";
  if (/badge|pill|tags?|chips?/i.test(componentName)) return "pill";
  if (/list|table|rows?|feed|history|log/i.test(componentName)) return "rows";
  // stat(?!us) — "RenewalStats" forms tiles, but "StatusRow" must not.
  if (/hero|stat(?!us)s?|metrics?|summary|kpi|overview|tiles?/i.test(componentName)) return "tiles";
  return "slab";
}

const band: CSSProperties = { display: "flex", gap: 10, width: "100%" };
const cell: CSSProperties = { flex: 1, minWidth: 0 };

/** The shape-aware streaming placeholder: shimmer silhouettes of the final
 *  geometry, so arrival is a crossfade instead of a slab popping into a view. */
export function FormingSkeleton({ name }: { name: string }) {
  const shape = deriveFormShape(name);
  if (shape === "tiles") {
    return (
      <span data-form-shape="tiles" style={band} aria-hidden="true">
        <span style={cell}><Skeleton height={64} /></span>
        <span style={cell}><Skeleton height={64} /></span>
        <span style={cell}><Skeleton height={64} /></span>
      </span>
    );
  }
  if (shape === "rows") {
    return (
      <span data-form-shape="rows" style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }} aria-hidden="true">
        <Skeleton height={40} />
        <Skeleton height={40} />
        <Skeleton height={40} />
      </span>
    );
  }
  if (shape === "chart") {
    return (
      <span data-form-shape="chart" style={{ display: "block", width: "100%" }} aria-hidden="true">
        <Skeleton height={180} />
      </span>
    );
  }
  if (shape === "control") {
    return (
      <span data-form-shape="control" style={{ display: "block", width: "100%" }} aria-hidden="true">
        <Skeleton width={148} height="var(--vendo-density-control-height, 38px)" />
      </span>
    );
  }
  if (shape === "pill") {
    return (
      <span data-form-shape="pill" style={{ display: "flex", justifyContent: "flex-end", width: "100%" }} aria-hidden="true">
        <Skeleton width={110} height={22} />
      </span>
    );
  }
  return (
    <span data-form-shape="slab" style={{ display: "block", width: "100%" }} aria-hidden="true">
      <Skeleton height="72px" />
    </span>
  );
}

/**
 * One PLAN LEAF that has not been filled yet (generation pipeline rebuild,
 * Task 5). A leaf is exactly one component, so a stat-shaped leaf is one tile —
 * the three-tile band above is the silhouette of a whole forming REGION, and
 * repeating it per leaf would show nine tiles for three stats.
 */
export function PendingLeaf({ name }: { name: string }) {
  if (deriveFormShape(name) !== "tiles") return <FormingSkeleton name={name} />;
  return (
    <span data-form-shape="tile" style={{ display: "block", width: "100%" }} aria-hidden="true">
      <Skeleton height={64} />
    </span>
  );
}
