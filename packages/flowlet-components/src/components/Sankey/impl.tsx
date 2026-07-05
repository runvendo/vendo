import { useMemo } from "react";
import { sankey, type SankeyGraph, type SankeyLink, type SankeyNode } from "d3-sankey";
import { linkHorizontal } from "d3-shape";
import type { z } from "zod";
import { useTheme } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { defaultBrand } from "../../theme/brand";
import { brandToChartPalette } from "../../theme/brand-to-chart-palette";
import { sankeySchema } from "./descriptor";

type SankeyProps = z.infer<typeof sankeySchema>;
type NodeDatum = SankeyProps["nodes"][number];
type LinkDatum = SankeyProps["links"][number] & { index: number };
type LayoutNode = SankeyNode<NodeDatum, LinkDatum>;
type LayoutLink = SankeyLink<NodeDatum, LinkDatum>;

const WIDTH = 760;
const NODE_WIDTH = 14;
const NODE_PADDING = 18;
const MIN_HEIGHT = 300;
const MAX_HEIGHT = 520;
const DEFAULT_PALETTE = brandToChartPalette(defaultBrand);
const MUTED = "var(--flowlet-fg-muted, rgba(0,0,0,0.55))";
const FG = "var(--flowlet-fg, #111418)";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function formatValue(value: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  });
}

function nodeValue(node: LayoutNode): number {
  return node.value ?? 0;
}

function asNode(node: LayoutLink["source"] | LayoutLink["target"]): LayoutNode {
  return node as LayoutNode;
}

function colorAt(palette: string[], index: number): string {
  return palette[index % palette.length] ?? DEFAULT_PALETTE[index % DEFAULT_PALETTE.length] ?? "#0A7CFF";
}

function createLayout(props: SankeyProps, height: number): SankeyGraph<NodeDatum, LinkDatum> {
  const graph: SankeyGraph<NodeDatum, LinkDatum> = {
    nodes: props.nodes.map((node) => ({ ...node })),
    links: props.links.map((link, index) => ({ ...link, index })),
  };

  return sankey<NodeDatum, LinkDatum>()
    .nodeId((node) => node.id)
    .nodeWidth(NODE_WIDTH)
    .nodePadding(NODE_PADDING)
    .nodeSort(null)
    .linkSort(null)
    .extent([
      [132, 30],
      [WIDTH - 172, height - 34],
    ])
    .iterations(32)(graph);
}

const linkPath = linkHorizontal<LayoutLink, [number, number]>()
  .source((link) => [asNode(link.source).x1 ?? 0, link.y0 ?? 0])
  .target((link) => [asNode(link.target).x0 ?? 0, link.y1 ?? 0]);

function SankeyView(props: SankeyProps) {
  const { mode, theme } = useTheme();
  const palette = theme.defaultChartPalette?.length ? theme.defaultChartPalette : DEFAULT_PALETTE;
  const height = clamp(220 + props.nodes.length * 24, MIN_HEIGHT, MAX_HEIGHT);
  const graph = useMemo(() => createLayout(props, height), [props, height]);

  const colorByNode = new Map<string, string>();
  graph.nodes.forEach((node, index) => {
    colorByNode.set(node.id, colorAt(palette, index));
  });

  const totalOut = graph.nodes
    .filter((node) => !node.targetLinks?.length)
    .reduce((sum, node) => sum + nodeValue(node), 0);
  const ariaTotal = totalOut > 0 ? ` Total source value ${formatValue(totalOut)}.` : "";
  const linkOpacity = mode === "dark" ? 0.46 : 0.34;

  return (
    <div
      data-sankey
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        color: FG,
        font: "var(--flowlet-font, 500 14px/1.4 system-ui, sans-serif)",
        width: "100%",
      }}
    >
      {props.title ? (
        <h3 style={{ margin: 0, color: FG, fontSize: 15, lineHeight: 1.25, fontWeight: 650 }}>
          {props.title}
        </h3>
      ) : null}
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        role="img"
        aria-label={`Sankey flow diagram with ${props.nodes.length} nodes and ${props.links.length} links.${ariaTotal}`}
        style={{ display: "block", height: "auto", overflow: "visible" }}
      >
        <g fill="none">
          {graph.links.map((link) => {
            const source = asNode(link.source);
            const target = asNode(link.target);
            const color = colorByNode.get(target.id) ?? colorByNode.get(source.id) ?? colorAt(palette, link.index);
            const width = Math.max(1, link.width ?? 1);
            return (
              <path
                key={`${source.id}-${target.id}-${link.index}`}
                data-sankey-link
                d={linkPath(link) ?? ""}
                stroke={color}
                strokeOpacity={linkOpacity}
                strokeWidth={width}
                strokeLinecap="butt"
                aria-label={`${source.label} to ${target.label}: ${formatValue(link.value)}`}
              >
                <title>{`${source.label} to ${target.label}: ${formatValue(link.value)}`}</title>
              </path>
            );
          })}
        </g>

        <g>
          {graph.nodes.map((node, index) => {
            const x0 = node.x0 ?? 0;
            const x1 = node.x1 ?? x0 + NODE_WIDTH;
            const y0 = node.y0 ?? 0;
            const y1 = node.y1 ?? y0;
            const midY = (y0 + y1) / 2;
            const isRightSide = x0 > WIDTH / 2;
            const labelX = isRightSide ? x1 + 10 : x0 - 10;
            const anchor = isRightSide ? "start" : "end";
            const color = colorByNode.get(node.id) ?? colorAt(palette, index);

            return (
              <g key={node.id} data-sankey-node>
                <rect
                  x={x0}
                  y={y0}
                  width={Math.max(2, x1 - x0)}
                  height={Math.max(2, y1 - y0)}
                  rx={4}
                  fill={color}
                >
                  <title>{`${node.label}: ${formatValue(nodeValue(node))}`}</title>
                </rect>
                <text
                  x={labelX}
                  y={midY - 4}
                  textAnchor={anchor}
                  fill={FG}
                  style={{ fontSize: 12.5, fontWeight: 650 }}
                >
                  {node.label}
                </text>
                <text
                  x={labelX}
                  y={midY + 12}
                  textAnchor={anchor}
                  fill={MUTED}
                  style={{ fontSize: 11.5, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}
                >
                  {formatValue(nodeValue(node))}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

export const Sankey = createPrewiredImpl(sankeySchema, (p) => <SankeyView {...p} />);
