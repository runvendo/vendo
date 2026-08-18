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
import { checkComponentScreen, type ComponentScreenCheck } from "../../src/server/checking/component-screen.js";
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
      <Text text={invoices.data.length + " " + (new Intl.PluralRules("en-US").select(invoices.data.length) === "one" ? "invoice" : "invoices")} />
      <Text text={"read " + new Intl.RelativeTimeFormat("en-US").format(-2, "hour")} />
      {invoices.data.map((row) => (
        <Card key={row.id} title={new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(row.amount_cents / 100)}>
          <Text text={"due " + new Date(row.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })} />
        </Card>
      ))}
    </Stack>
  );
}
`;

/** Every string in the paint this gate hands the renderer — so nothing here is
 *  asking the compiler what the VM did. */
const paintedStrings = (result: ComponentScreenCheck): string[] =>
  Object.values(result.initialTree?.nodes ?? {}).flatMap((node) =>
    Object.values(node.props).filter((value): value is string => typeof value === "string"));

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
    // The total, computed in the box; one row's own amount; one row's own date —
    // the last of which is the DEFAULT wall's answer, UTC.
    expect(paintedStrings(result)).toContain("$4,755.55");
    expect(paintedStrings(result)).toContain("$555.55");
    expect(paintedStrings(result)).toContain("due Aug 17");
    // The two formats that only became reachable in the box after the bridge grew
    // them: the compiler has always admitted both, so before they crossed the wall
    // this pair was a green check over a screen that could not run.
    expect(paintedStrings(result)).toContain("2 invoices");
    expect(paintedStrings(result)).toContain("read 2 hours ago");
  });
});

describe("the wall the gate paints on", () => {
  it("paints in the zone the HOST passed, not the server's own", async () => {
    // The row is due at 01:30Z — the 17th in UTC and the 16th in New York. The
    // check above painted this screen over this row on the default wall and read
    // "due Aug 17", so the zone is the whole difference between the two, and it
    // only reaches the box if the gauntlet forwards it to the paint. A gate that
    // dropped it would judge a date the person is never shown.
    const result = await checkComponentScreen({
      source: SCREEN,
      hostTools: tools,
      catalog,
      runQuery: async () => ROWS,
      timeZone: "America/New_York",
    });

    expect(result.issues).toEqual([]);
    expect(paintedStrings(result)).toContain("due Aug 16");
  });
});
