/**
 * `<ActionButton>` — a write as ONE element, through the real gauntlet and the
 * real engine.
 *
 * Two claims, and they are the whole feature:
 *
 *  1. THE COMPILER DECIDES WHETHER THE PRESS IS REAL. `tool` is the written-out
 *     name of a tool this host has and `args` is that tool's own payload, so a
 *     name it does not have, a name that is not a literal, and a key the schema
 *     does not take are each refused before the screen ever runs — the same
 *     answers `tools.<name>(args)` already gets in a handler.
 *  2. THE PRESS FILES WHAT A HANDLER FILES. Proven by booting the compiled
 *     screen this check hands back, firing the handler the painted tree names,
 *     and reading the intent out — nothing stubbed on either side, because a
 *     button that paints and calls nothing is exactly the failure this replaces.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { JsonSchema } from "@vendoai/core";
import { bootScreen, flattenTree, warmScreenEngine } from "../../src/contract/index.js";
import {
  checkComponentScreen,
  screenCatalog,
  type ComponentScreenCheck,
} from "../../src/server/checking/component-screen.js";
import type { HostToolInfo } from "../../src/server/checking/deps.js";

const pendingSchema: JsonSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, recipient: { type: "string" } },
        required: ["id", "recipient"],
        additionalProperties: false,
      },
    },
  },
  required: ["data"],
  additionalProperties: false,
};

const tools: readonly HostToolInfo[] = [
  {
    name: "list_pending_transfers",
    description: "Transfers waiting to go out",
    risk: "read",
    outputSchema: pendingSchema,
  },
  {
    name: "cancel_transfer",
    description: "Cancel one pending transfer",
    risk: "destructive",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "resend_receipts",
    description: "Send today's receipts again",
    risk: "write",
    inputSchema: { type: "object", properties: { since: { type: "string" } }, additionalProperties: false },
  },
];

const ROWS = { data: [{ id: "tr_1", recipient: "Ada" }] };

const catalog = screenCatalog([]);

const check = async (source: string): Promise<ComponentScreenCheck> =>
  checkComponentScreen({ source, hostTools: tools, catalog, runQuery: async () => ROWS });

const refusal = async (source: string): Promise<string> => {
  const result = await check(source);
  if (result.ok) throw new Error("expected the gauntlet to refuse this screen");
  return result.issues.map(({ message }) => message).join("\n");
};

/** One screen, both shapes of the component: a tool whose schema REQUIRES a
 *  payload, and one whose schema does not. */
const SCREEN = `import { ActionButton, Card, Stack, Text, useQuery } from "@vendo/screen";

export default function PendingTransfers() {
  const pending = useQuery("list_pending_transfers");

  return (
    <Stack gap={12}>
      <Text text="Transfers waiting to go out" variant="heading" />
      <ActionButton tool="resend_receipts" label="Resend receipts" variant="secondary" />
      {pending.data.map((transfer) => (
        <Card key={transfer.id} title={transfer.recipient}>
          <ActionButton tool="cancel_transfer" args={{ id: transfer.id }} label="Cancel" variant="danger" />
        </Card>
      ))}
    </Stack>
  );
}
`;

/** The painted Button nodes, in paint order, with the handler each one carries. */
const buttons = (nodes: Record<string, { component: string; props: Record<string, unknown> }>) =>
  Object.entries(nodes)
    .filter(([, node]) => node.component === "Button")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, node]) => ({ id, props: node.props }));

beforeAll(async () => {
  await warmScreenEngine();
});

describe("a screen that presses through <ActionButton>", () => {
  it("passes, and paints the Kit's own Button with a handler — never the tool name as a prop", async () => {
    const result = await check(SCREEN);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);

    const painted = buttons(result.initialTree?.nodes ?? {});
    expect(painted).toHaveLength(2);
    // The rendered control is a Button like any other: what it calls lives in the
    // handler, so `tool` and `args` never reach the surface as props.
    expect(painted[0]?.props).toEqual({
      label: "Resend receipts",
      variant: "secondary",
      onClick: { $handler: expect.stringMatching(/^h\d+$/u) },
    });
    expect(painted[1]?.props).toEqual({
      label: "Cancel",
      variant: "danger",
      onClick: { $handler: expect.stringMatching(/^h\d+$/u) },
    });
  });

  it("files exactly the intent a handler files when the button is pressed", async () => {
    const result = await check(SCREEN);
    expect(result.ok).toBe(true);

    // The seam: boot what the check handed back, the way the renderer does
    // (`packages/ui` use-screen.ts), and press.
    const screen = bootScreen({
      compiledSource: result.compiled ?? "",
      queries: result.queries ?? {},
      catalog: [...catalog].map((entry) => (typeof entry === "string" ? entry : entry.name)),
      now: Date.UTC(2026, 7, 13),
    });
    try {
      const painted = buttons(flattenTree(screen.tree()).nodes);
      const rowPress = painted[1]?.props.onClick as { $handler: string };
      const fired = screen.fire(rowPress.$handler);

      // The row's own id, off the row it was rendered from — and the SAME shape
      // `tools.cancel_transfer({ id })` records, so everything downstream (the
      // guard, the approval, the refresh) sees a press it already knows how to
      // answer.
      expect(fired.intents).toEqual([
        { id: expect.stringMatching(/^i\d+$/u), tool: "cancel_transfer", args: { id: "tr_1" } },
      ]);

      // A tool whose schema requires nothing files with no payload at all.
      const bare = painted[0]?.props.onClick as { $handler: string };
      expect(screen.fire(bare.$handler).intents).toEqual([
        { id: expect.stringMatching(/^i\d+$/u), tool: "resend_receipts", args: undefined },
      ]);
    } finally {
      screen.dispose();
    }
  });
});

describe("what the compiler refuses", () => {
  const screenAround = (element: string): string => `import { ActionButton, Stack, useQuery } from "@vendo/screen";

export default function Screen() {
  const pending = useQuery("list_pending_transfers");
  return <Stack gap={8}>{pending.data.map((transfer) => (${element}))}</Stack>;
}
`;

  it("refuses a tool this host does not have", async () => {
    const text = await refusal(screenAround(
      `<ActionButton key={transfer.id} tool="cancel_transfers" args={{ id: transfer.id }} label="Cancel" />`,
    ));
    expect(text).toContain("cancel_transfer");
    expect(text).toMatch(/cancel_transfers/u);
  });

  it("refuses a tool name computed from the data", async () => {
    const text = await refusal(screenAround(
      `<ActionButton key={transfer.id} tool={transfer.recipient} args={{ id: transfer.id }} label="Cancel" />`,
    ));
    expect(text).toContain('prop "tool"');
    // …and it says what it would have taken, so the repair is the name itself.
    expect(text).toContain("cancel_transfer");
  });

  it("refuses a payload the tool's own schema does not accept", async () => {
    const text = await refusal(screenAround(
      `<ActionButton key={transfer.id} tool="cancel_transfer" args={{ transferId: transfer.id }} label="Cancel" />`,
    ));
    expect(text).toContain("transferId");
  });

  it("refuses a press with no payload where the tool's schema requires one", async () => {
    const text = await refusal(screenAround(
      `<ActionButton key={transfer.id} tool="cancel_transfer" label="Cancel" />`,
    ));
    expect(text).toContain("args");
  });

  it("refuses a prop the Button it renders does not have", async () => {
    const text = await refusal(screenAround(
      `<ActionButton key={transfer.id} tool="cancel_transfer" args={{ id: transfer.id }} label="Cancel" tone="danger" />`,
    ));
    expect(text).toContain("tone");
  });
});
