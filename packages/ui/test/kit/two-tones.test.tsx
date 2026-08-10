// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataTable, type DataTableColumn } from "../../src/kit/data/data-table.js";
import { Text } from "../../src/kit/values.js";

/** Every body cell's text mapped to whether it renders in the muted tone. */
function cellTones(markup: string): Record<string, boolean> {
  const body = markup.slice(markup.indexOf("<tbody"));
  const tones: Record<string, boolean> = {};
  for (const [, style, text] of body.matchAll(/<td[^>]*style="([^"]*)"[^>]*>(.*?)<\/td>/g)) {
    tones[text.replace(/<[^>]*>/g, "")] = style.includes("--vendo-color-muted");
  }
  return tones;
}

const accounts = [{ id: "acc_1", name: "Maple Checking", kind: "checking", mask: "4471", balance: "$9,412.20" }];

describe("two text tones", () => {
  it("mutes a table's supporting columns, keeping identity and quantities full strength", () => {
    const columns: DataTableColumn[] = [
      { key: "name", label: "Account" },
      { key: "kind", label: "Type" },
      { key: "mask", label: "Number" },
      { key: "balance", label: "Balance", align: "end" },
    ];
    expect(cellTones(renderToStaticMarkup(<DataTable rows={accounts} columns={columns} />))).toEqual({
      "Maple Checking": false,
      checking: true,
      "4471": true,
      "$9,412.20": false,
    });
  });

  it("treats a raw id column as supporting copy, not the row's identity", () => {
    const columns: DataTableColumn[] = [
      { key: "id", label: "ID" },
      { key: "name", label: "Account" },
      { key: "balance", label: "Balance", format: "money" },
    ];
    const tones = cellTones(renderToStaticMarkup(<DataTable rows={[{ id: "acc_1", name: "Maple Checking", balance: 941220 }]} columns={columns} />));
    expect(tones["acc_1"]).toBe(true);
    expect(tones["Maple Checking"]).toBe(false);
    expect(tones["$9,412.20"]).toBe(false);
  });

  it("stays in one tone when no column is a quantity", () => {
    const columns: DataTableColumn[] = [
      { key: "key", label: "Task" },
      { key: "title", label: "Title" },
      { key: "assignee", label: "Assignee" },
    ];
    const tones = cellTones(
      renderToStaticMarkup(<DataTable rows={[{ key: "ENG-1", title: "Ship it", assignee: "Ada" }]} columns={columns} />),
    );
    expect(Object.values(tones)).toEqual([false, false, false]);
  });

  it("renders a label in the muted tone and a value at full strength", () => {
    expect(renderToStaticMarkup(<Text text="Sent to" variant="label" />)).toContain("--vendo-color-muted");
    expect(renderToStaticMarkup(<Text text="Alex Rivera" variant="body" />)).not.toContain("--vendo-color-muted");
  });
});
