/**
 * A slot written as a FUNCTION that returns its element — one law, every slot.
 *
 * `rowActions={(row) => <Button onClick={() => tools.cancel({ id: row.id })}/>}`
 * and `footer={() => <Button/>}` are what React trains anyone to write, and they
 * were the one thing that could not work: a function prop crossed the VM boundary
 * as a single `$handler` door, so the component was handed a callback where an
 * element belongs and the slot came out blank — or, worse, one handler for forty
 * rows.
 *
 * Now the VM calls it. A slot the Kit paints once is called with no arguments,
 * because it has no row to be a function of; a per-row slot is called once per
 * row, each call under its own slot path, so every row's handler is its own —
 * which is what makes the closure over `row` real. What comes out then is a LIST,
 * and the Kit matches it back to the rows it drew.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { KIT_SLOT_PROPS } from "../../../../src/contract/kit/specs.js";
import { warmScreenEngine, type NestedNode } from "../../../../src/contract/genui/component/index.js";
import { bootTsx, nodeOf } from "./screen-fixture.test-util.js";

beforeAll(async () => {
  await warmScreenEngine();
});

const TABLE = `
import { Button, DataTable, EnumBadge, Stack, Text, tools, useQuery } from "@vendo/screen";

export default function Invoices() {
  const rows = useQuery("list_invoices");
  return (
    <Stack gap={8}>
      <DataTable
        rows={rows}
        columns={[
          { key: "client" },
          { key: "amount", cell: (row) => <Text text={(row.amount_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} /> },
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
      expect(amounts.map((node) => node.props.text)).toEqual(["$42.00", "$9.00"]);
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
    for (const [component, slots] of Object.entries(KIT_SLOT_PROPS)) {
      for (const [prop, spec] of Object.entries(slots)) {
        if (spec.rows === undefined) continue;
        expect(spec.rows, `${component}.${prop}`).toBeTypeOf("string");
      }
    }
    expect(KIT_SLOT_PROPS.DataTable).toEqual({
      columns: { rows: "rows", field: "cell" },
      rowActions: { rows: "rows" },
      toolbar: {},
      empty: {},
    });
  });
});

/**
 * THE OTHER ARITY, and the carve-out that is gone: a slot the Kit paints ONCE,
 * written as a function of nothing.
 *
 * The per-row slots learned to take a function and the rest did not, so
 * `footer={() => <Button/>}` — the same reflex, one component over — still crossed
 * as a `$handler` and painted nothing. One law now: the VM calls whatever function
 * a declared slot holds, and a slot with no rows behind it is called with no
 * arguments.
 */
describe("a slot painted once, written as a function", () => {
  it("calls it with no arguments and paints what it returns", () => {
    const screen = bootTsx(`
import { Button, Card, Text } from "@vendo/screen";
export default function Panel() {
  return <Card title="Transfers" footer={() => <Button label="New transfer" />}><Text text="body" /></Card>;
}
`);
    try {
      const card = nodeOf(screen.tree(), "Card")!;
      const footer = card.props.footer as NestedNode;
      expect(footer.component).toBe("Button");
      expect(footer.props.label).toBe("New transfer");
      // Sigilled, like any element in a prop, so the renderer builds a component
      // back out of it rather than reading it as data.
      expect((footer as { $element?: unknown }).$element).toBe(true);
    } finally {
      screen.dispose();
    }
  });

  it("keeps the handlers inside it, one door apiece", () => {
    const screen = bootTsx(`
import { Button, Card, Row, Text, tools } from "@vendo/screen";
export default function Panel() {
  return (
    <Card
      title="Transfers"
      footer={() => (
        <Row>
          <Button label="Cancel" onClick={() => tools.cancel_invoice({ id: "in_1" })} />
          <Button label="Retry" onClick={() => tools.cancel_invoice({ id: "in_2" })} />
        </Row>
      )}
    >
      <Text text="body" />
    </Card>
  );
}
`);
    try {
      const footer = nodeOf(screen.tree(), "Card")!.props.footer as NestedNode;
      const ids = handlerIds(footer);
      expect(new Set(ids).size).toBe(2);
      expect(screen.fire(ids[1]!).intents).toEqual([
        { id: "i1", tool: "cancel_invoice", args: { id: "in_2" } },
      ]);
    } finally {
      screen.dispose();
    }
  });

  /** A slot nested in a description object takes the same function, with the same
   *  arity: `Accordion.items[].content` has no rows behind it either. */
  it("calls a nested slot's function too, and leaves the rest of the entry alone", () => {
    const screen = bootTsx(`
import { Accordion, Text } from "@vendo/screen";
export default function Panels() {
  return <Accordion items={[{ label: "Terms", content: () => <Text text="the terms" /> }]} />;
}
`);
    try {
      const items = nodeOf(screen.tree(), "Accordion")!.props.items as Array<Record<string, unknown>>;
      expect(items[0]!.label).toBe("Terms");
      expect((items[0]!.content as NestedNode).props.text).toBe("the terms");
    } finally {
      screen.dispose();
    }
  });

  /** A function that throws is a PAINT failure, the same path a function of the
   *  row takes — the VM calls it during the paint, so the throw is the paint's. */
  it("fails the paint when the function throws", () => {
    expect(() => bootTsx(`
import { Card, Text } from "@vendo/screen";
export default function Panel() {
  return <Card title="Transfers" footer={() => { throw new Error("no footer for you"); }}><Text text="body" /></Card>;
}
`)).toThrow(/no footer for you/u);
  });
});
