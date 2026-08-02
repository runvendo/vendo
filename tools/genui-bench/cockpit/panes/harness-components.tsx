/**
 * The shared domain harness for the registered-components competitor lanes
 * (CopilotKit, Tambo): three simple presentational components (chart, table,
 * form) plus the per-host catalog the adapters register with each SDK. The
 * competitor's model picks a component + props; WE render it — that asymmetry
 * is stated permanently in each pane's footnote.
 *
 * No hooks and no "use client" on purpose: the adapters import
 * `buildHarnessCatalog`/`harnessRegistry` server-side (CLI + API routes), and
 * the cockpit panes render the same components in the browser.
 */
import type { ComponentType } from "react";
import type { HostFixture } from "../../runner/types";

export type HarnessComponentName = "chart" | "table" | "form";

export interface HarnessChartProps {
  title?: string;
  data: Array<{ label: string; value: number }>;
}

export type HarnessTableCell = string | number;
/** A competitor's orchestration may hand back an array-of-arrays as an
 *  index-keyed object ({"0": "Checking", "1": 12846.5}) — Tambo's hosted
 *  service did exactly that on the 2026-07-26 live run. Accept both. */
export type HarnessTableRow = HarnessTableCell[] | Record<string, HarnessTableCell>;

export interface HarnessTableProps {
  title?: string;
  columns: string[];
  rows: HarnessTableRow[];
}

function rowCells(row: HarnessTableRow): HarnessTableCell[] {
  return Array.isArray(row) ? row : Object.values(row ?? {});
}

export interface HarnessFormProps {
  title?: string;
  fields: Array<{ name: string; label: string; type?: string; options?: string[] }>;
  submitLabel?: string;
}

const box: React.CSSProperties = {
  border: "1px solid #2a2a33",
  borderRadius: 8,
  padding: 12,
  fontFamily: "system-ui, sans-serif",
  fontSize: 13,
  color: "#e6e6ea",
  background: "#17171c",
};
const heading: React.CSSProperties = { margin: "0 0 8px", fontSize: 13, fontWeight: 600 };

export function HarnessChart({ title, data }: HarnessChartProps) {
  const values = Array.isArray(data) ? data : [];
  const max = Math.max(1, ...values.map((d) => Math.abs(Number(d.value) || 0)));
  return (
    <div style={box} data-harness="chart">
      {title ? <p style={heading}>{title}</p> : null}
      {values.map((d, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0" }}>
          <span style={{ width: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {d.label}
          </span>
          <div style={{ flex: 1, background: "#26262e", borderRadius: 3, height: 14 }}>
            <div
              style={{
                width: `${(Math.abs(Number(d.value) || 0) / max) * 100}%`,
                height: "100%",
                background: "#7c6cf0",
                borderRadius: 3,
              }}
            />
          </div>
          <span style={{ width: 80, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {Number(d.value).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

export function HarnessTable({ title, columns, rows }: HarnessTableProps) {
  return (
    <div style={box} data-harness="table">
      {title ? <p style={heading}>{title}</p> : null}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {(columns ?? []).map((c) => (
              <th key={c} style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid #2a2a33" }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((row, i) => (
            <tr key={i}>
              {rowCells(row).map((cell, j) => (
                <td key={j} style={{ padding: "4px 8px", borderBottom: "1px solid #222229" }}>
                  {String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HarnessForm({ title, fields, submitLabel }: HarnessFormProps) {
  return (
    <form style={box} data-harness="form" onSubmit={(e) => e.preventDefault()}>
      {title ? <p style={heading}>{title}</p> : null}
      {(fields ?? []).map((f) => (
        <label key={f.name} style={{ display: "block", margin: "6px 0" }}>
          <span style={{ display: "block", marginBottom: 2, color: "#a8a8b3" }}>{f.label}</span>
          {f.options?.length ? (
            <select name={f.name} style={{ width: "100%", padding: 4 }}>
              {f.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input name={f.name} type={f.type ?? "text"} style={{ width: "100%", padding: 4, boxSizing: "border-box" }} />
          )}
        </label>
      ))}
      <button type="submit" style={{ marginTop: 8, padding: "6px 14px", borderRadius: 6 }}>
        {submitLabel ?? "Submit"}
      </button>
    </form>
  );
}

/** Render registry the CopilotKit/Tambo panes key their model's picks into. */
export const harnessRegistry: Record<HarnessComponentName, ComponentType<never>> = {
  chart: HarnessChart as ComponentType<never>,
  table: HarnessTable as ComponentType<never>,
  form: HarnessForm as ComponentType<never>,
};

export interface HarnessComponentDescriptor {
  name: HarnessComponentName;
  description: string;
  /** JSON Schema — the shape both CopilotKit (AG-UI tool parameters) and Tambo (propsSchema) accept. */
  propsSchema: Record<string, unknown>;
}

const chartSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    data: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, value: { type: "number" } },
        required: ["label", "value"],
      },
    },
  },
  required: ["data"],
} as const;

const tableSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    columns: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: { type: "array", items: { type: ["string", "number"] } } },
  },
  required: ["columns", "rows"],
} as const;

const formSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          label: { type: "string" },
          type: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["name", "label"],
      },
    },
    submitLabel: { type: "string" },
  },
  required: ["fields"],
} as const;

/** Per-host component catalog: names/descriptions carry the host's tool
 *  vocabulary so the competitor's model routes data into the right component. */
export function buildHarnessCatalog(host: HostFixture): HarnessComponentDescriptor[] {
  const toolNames = (host.tools as Array<{ name?: string }>)
    .map((t) => t?.name)
    .filter((n): n is string => typeof n === "string")
    .slice(0, 8);
  const vocab = toolNames.length > 0 ? ` (e.g. results of ${toolNames.join(", ")})` : "";
  return [
    {
      name: "chart",
      description: `Bar chart of labeled numeric values from ${host.name} data${vocab}. Use for balances, totals, spending by category, or any comparison of amounts.`,
      propsSchema: chartSchema as unknown as Record<string, unknown>,
    },
    {
      name: "table",
      description: `Data table for ${host.name} records${vocab}. Use for lists such as transactions, accounts, or invoices.`,
      propsSchema: tableSchema as unknown as Record<string, unknown>,
    },
    {
      name: "form",
      description: `Input form for ${host.name} actions such as transfers or payments. Fields should mirror the target tool's input schema.`,
      propsSchema: formSchema as unknown as Record<string, unknown>,
    },
  ];
}

export function isHarnessComponentName(name: string): name is HarnessComponentName {
  return name === "chart" || name === "table" || name === "form";
}
