/**
 * A slot the Kit paints once per row, written as a function of the row.
 *
 * `rowActions={(row) => <Button onClick={() => tools.cancel({ id: row.id })}/>}`
 * is what React trains anyone to write, and it was the one thing that could not
 * work: a function prop crossed the VM boundary as a single `$handler` door, so
 * the table was handed a callback where an element belongs and the column came
 * out blank — or, worse, one handler for forty rows.
 *
 * Now the VM calls it. Once per row, each call under its own slot path, so every
 * row's handler is its own — which is what makes the closure over `row` real.
 * What comes out is a LIST, and the Kit matches it back to the rows it drew.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { KIT_PER_ROW_SLOTS } from "../../../../src/contract/kit/specs.js";
import { warmScreenEngine, type NestedNode } from "../../../../src/contract/genui/component/index.js";
import { bootTsx, nodeOf } from "./screen-fixture.test-util.js";

beforeAll(async () => {
  await warmScreenEngine();
});

const TABLE = `
import { Button, DataTable, EnumBadge, Money, Stack, Text, tools, useQuery } from "@vendo/screen";

export default function Invoices() {
  const rows = useQuery("list_invoices");
  return (
    <Stack gap={8}>
      <DataTable
        rows={rows}
        columns={[
          { key: "client" },
          { key: "amount", cell: (row) => <Money value={row.amount_cents / 100} /> },
          { key: "status", cell: (row) => <EnumBadge value={row.status} /> },
        ]}
        rowActions={(row) => <Button label={"Cancel " + row.client} onClick={() => tools.cancel_invoice({ id: row.id })} />}
      />
    </Stack>
  );
}
`;

const ROWS = [
  { id: "in_1", client: "Ada", amount_cents: 4_200, status: "open" },
  { id: "in_2", client: "Bob", amount_cents: 900, status: "paid" },
];

const table = (tree: NestedNode): Record<string, unknown> => nodeOf(tree, "DataTable")!.props;

/** Every `$handler` id inside one emitted prop, in order. */
const handlerIds = (value: unknown): string[] => {
  const found: string[] = [];
  const walk = (at: unknown): void => {
    if (Array.isArray(at)) {
      for (const item of at) walk(item);
      return;
    }
    if (at === null || typeof at !== "object") return;
    const id = (at as { $handler?: unknown }).$handler;
    if (typeof id === "string") found.push(id);
    for (const item of Object.values(at)) walk(item);
  };
  walk(value);
  return found;
};

describe("a per-row slot written as a function", () => {
  it("paints one element PER ROW, each with its own handler", () => {
    const screen = bootTsx(TABLE, { list_invoices: ROWS });
    try {
      const actions = table(screen.tree()).rowActions as NestedNode[];
      expect(actions).toHaveLength(2);
      expect(actions.map((node) => node.props.label)).toEqual(["Cancel Ada", "Cancel Bob"]);
      // The whole point: two rows, two handlers. One id for both rows was the
      // defect — every Cancel button cancelling the first row.
      expect(new Set(handlerIds(actions)).size).toBe(2);
    } finally {
      screen.dispose();
    }
  });

  it("fires the row's OWN closure, so the tool call carries that row's id", () => {
    const screen = bootTsx(TABLE, { list_invoices: ROWS });
    try {
      const actions = table(screen.tree()).rowActions as NestedNode[];
      const second = handlerIds(actions)[1]!;
      expect(screen.fire(second).intents).toEqual([
        { id: "i1", tool: "cancel_invoice", args: { id: "in_2" } },
      ]);
    } finally {
      screen.dispose();
    }
  });

  it("maps a cell inside a column description, and leaves the rest of it alone", () => {
    const screen = bootTsx(TABLE, { list_invoices: ROWS });
    try {
      const columns = table(screen.tree()).columns as Array<Record<string, unknown>>;
      expect(columns[0]).toEqual({ key: "client" });
      const amounts = columns[1]!.cell as NestedNode[];
      expect(columns[1]!.key).toBe("amount");
      expect(amounts.map((node) => node.props.value)).toEqual([42, 9]);
      // A slot element is sigilled wherever it lands, so the renderer builds a
      // component back out of it rather than reading it as data.
      expect(amounts.every((node) => (node as { $element?: unknown }).$element === true)).toBe(true);
    } finally {
      screen.dispose();
    }
  });

  it("still takes a plain ELEMENT, which is what a stored screen holds", () => {
    const screen = bootTsx(`
import { DataTable, Text, useQuery } from "@vendo/screen";
export default function S() {
  return <DataTable rows={useQuery("list_invoices")} columns={[{ key: "client", cell: <Text text="fixed" /> }]} />;
}
`, { list_invoices: ROWS });
    try {
      const columns = table(screen.tree()).columns as Array<Record<string, unknown>>;
      expect((columns[0]!.cell as NestedNode).props.text).toBe("fixed");
    } finally {
      screen.dispose();
    }
  });

  it("declares a rows prop for every per-row slot — a function has to map over something", () => {
    for (const [component, slots] of Object.entries(KIT_PER_ROW_SLOTS)) {
      for (const [prop, spec] of Object.entries(slots)) {
        expect(spec.rows, `${component}.${prop}`).toBeTypeOf("string");
      }
    }
    expect(KIT_PER_ROW_SLOTS.DataTable).toEqual({
      columns: { rows: "rows", field: "cell" },
      rowActions: { rows: "rows" },
    });
  });
});
