/**
 * The formatting idiom, through the WHOLE gauntlet: real esbuild, the real
 * TypeScript compiler, the real VM.
 *
 * `amount.toLocaleString("en-US", { style: "currency", currency: "USD" })` and
 * `new Date(row.due).toLocaleDateString("en-US", { month: "short", day:
 * "numeric" })` are what a model writes for money and dates whether or not
 * anything asked it to, and the two halves that have to agree about them sit at
 * opposite ends of this package: the declarations `tsc` reads
 * (`server/checking/screen-typings.ts`, whose lib is `lib.es2020.d.ts` and
 * therefore carries `Intl`) and the VM the screen actually runs in
 * (`contract/genui/component/vm-program.ts`, which has no ICU and borrows the
 * host's). Either one alone can be green while the pair is broken — the compiler
 * admitting a call the box then degrades to `toString()` is exactly what shipped
 * before the bridge — so this file asks the gate, and reads the answer off the
 * PAINT the same gate hands the renderer.
 */
import { describe, expect, it } from "vitest";
import { checkComponentScreen } from "../../src/server/checking/component-screen.js";
import type { HostToolInfo } from "../../src/server/checking/deps.js";

const tools: readonly HostToolInfo[] = [
  {
    name: "list_invoices",
    description: "Invoices, with what each is for",
    risk: "read",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, amount_cents: { type: "number" }, due: { type: "string" } },
            required: ["id", "amount_cents", "due"],
            additionalProperties: false,
          },
        },
      },
      required: ["data"],
      additionalProperties: false,
    },
  },
];

const catalog = ["Stack", "Card", "Text"];

const ROWS = {
  data: [
    { id: "in_1", amount_cents: 420_000, due: "2026-08-17T01:30:00Z" },
    { id: "in_2", amount_cents: 55_555, due: "2026-09-02T01:30:00Z" },
  ],
};

const SCREEN = `import { Card, Stack, Text } from "@vendo/screen";
import { useQuery } from "@vendo/screen";

export default function Invoices() {
  const invoices = useQuery("list_invoices");
  const total = invoices.data.reduce((sum, row) => sum + row.amount_cents, 0) / 100;
  return (
    <Stack gap={12}>
      <Text text={total.toLocaleString("en-US", { style: "currency", currency: "USD" })} variant="heading" />
      {invoices.data.map((row) => (
        <Card key={row.id} title={new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(row.amount_cents / 100)}>
          <Text text={"due " + new Date(row.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })} />
        </Card>
      ))}
    </Stack>
  );
}
`;

describe("the formatting idiom", () => {
  it("type-checks, runs, and paints the strings a browser would paint", async () => {
    const result = await checkComponentScreen({
      source: SCREEN,
      hostTools: tools,
      catalog,
      runQuery: async () => ROWS,
    });

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    // Read off the paint the gate hands the renderer, so nothing here is asking
    // the compiler what the VM did.
    const painted = Object.values(result.initialTree?.nodes ?? {}).flatMap((node) =>
      Object.values(node.props).filter((value): value is string => typeof value === "string"));
    // The total, computed in the box; one row's own amount; one row's own date.
    expect(painted).toContain("$4,755.55");
    expect(painted).toContain("$555.55");
    expect(painted).toContain("due Aug 17");
  });
});
