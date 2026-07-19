import type { CSSProperties } from "react";
import { Skeleton } from "./primitives.js";

export type FormShape = "slab" | "tiles" | "rows" | "pill";

/**
 * Pick A (ui-lane-renderer, 2026-07-19) — the tree streams before generated
 * component SOURCES arrive, so a forming node's silhouette can only come from
 * what its name says the component is. Anything unrecognized keeps the
 * historical 72px slab, so the fallback is never worse than before.
 */
export function deriveFormShape(componentName: string): FormShape {
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
