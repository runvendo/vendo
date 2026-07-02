/**
 * Placeholder shown while the agent is composing a view — holds the space (in
 * roughly the shape of the component being built) so the thread doesn't jump,
 * then the real UI swaps in. When a render tool's streaming input exposes a
 * component name, we map it to a shape archetype; nameless/unknown inputs fall
 * back to the generic card.
 */
import type { CSSProperties } from "react";

const bar = (style: CSSProperties, key?: number) => (
  <div key={key} className="fl-skeleton-bar" style={style} />
);

export type SkeletonShape = "chart" | "table" | "list" | "stat" | "card";

/** Map a component name to a skeleton archetype. */
export function skeletonShape(name?: string): SkeletonShape {
  if (!name) return "card";
  const n = name.toLowerCase();
  if (/chart|graph|spark|trend|plot/.test(n)) return "chart";
  if (/table|grid|ledger|transactions|rows|history/.test(n)) return "table";
  if (/list|feed|items|activity/.test(n)) return "list";
  if (/stat|kpi|metric|balance|total|summary|score|number/.test(n)) return "stat";
  return "card";
}

function ChartSkel() {
  const heights = [40, 66, 52, 80, 60, 90, 48];
  return (
    <>
      {bar({ width: "44%", height: 11, marginBottom: 14 })}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 92 }}>
        {heights.map((h, i) => bar({ flex: 1, height: `${h}%`, borderRadius: 6 }, i))}
      </div>
    </>
  );
}

function TableSkel() {
  return (
    <>
      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        {bar({ width: "24%", height: 9 })}
        {bar({ width: "34%", height: 9 })}
        {bar({ width: "18%", height: 9, marginLeft: "auto" })}
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} style={{ display: "flex", gap: 12, marginBottom: 10, alignItems: "center" }}>
          {bar({ width: "24%", height: 11 })}
          {bar({ width: "40%", height: 11 })}
          {bar({ width: "16%", height: 11, marginLeft: "auto" })}
        </div>
      ))}
    </>
  );
}

function ListSkel() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 13 }}>
          {bar({ width: 30, height: 30, borderRadius: 9 })}
          <div style={{ flex: 1 }}>
            {bar({ width: "58%", height: 10, marginBottom: 6 })}
            {bar({ width: "34%", height: 8 })}
          </div>
          {bar({ width: 44, height: 12, borderRadius: 6 })}
        </div>
      ))}
    </>
  );
}

function StatSkel() {
  return (
    <>
      {bar({ width: "34%", height: 9, marginBottom: 12 })}
      {bar({ width: "52%", height: 26, borderRadius: 8, marginBottom: 10 })}
      {bar({ width: "40%", height: 9 })}
    </>
  );
}

function CardSkel() {
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 13 }}>
        {bar({ width: 30, height: 30, borderRadius: 9 })}
        <div style={{ flex: 1 }}>
          {bar({ width: "60%", height: 11, marginBottom: 6 })}
          {bar({ width: "38%", height: 9 })}
        </div>
      </div>
      {bar({ width: "100%", height: 84, borderRadius: 11, marginBottom: 11 })}
      {bar({ width: "88%", height: 9, marginBottom: 6 })}
      {bar({ width: "64%", height: 9 })}
    </>
  );
}

const SHAPES = { chart: ChartSkel, table: TableSkel, list: ListSkel, stat: StatSkel, card: CardSkel };

export function Skeleton({ name }: { name?: string }) {
  const Shape = SHAPES[skeletonShape(name)];
  return (
    <div className="fl-skeleton" aria-hidden="true" data-shape={skeletonShape(name)}>
      <Shape />
    </div>
  );
}
