/**
 * The two gates that decide whether an engine prop is legal, driven together on
 * one screen each — the wire dialect's bespoke allowed-prop set
 * (`prewiredPropsIssues`) and the component screen's real `tsc`. Both must let
 * `<Sparkline stroke=…>` through, and BOTH must still refuse a name no engine
 * and no spec carries: passthrough opens the components that wrap an engine, and
 * nothing else.
 */
import { describe, expect, it } from "vitest";
import type { Tree } from "../../src/contract/index.js";
import { catalogIssues } from "../../src/server/checking/facts.js";
import {
  COMPONENT_SCREEN_LIB,
  componentScreenTypings,
  screenCatalog,
} from "../../src/server/checking/screen-typings.js";
import { screenTscFindings } from "../../src/server/checking/screen-tsc.js";

const typings = componentScreenTypings({ catalog: screenCatalog([]), tools: [] });

/** The `app.tsx` a screen really is, around one element. */
const tsc = (body: string, imports: string): string[] =>
  screenTscFindings({
    screen: `import { Stack, ${imports} } from "@vendo/screen";

export default function Screen() {
  return (
    <Stack gap={12}>
      ${body}
    </Stack>
  );
}
`,
    typings,
    lib: COMPONENT_SCREEN_LIB,
  }).map((finding) => finding.message);

/** The same element as a stored tree, which is what the bespoke walker reads. */
const bespoke = async (component: string, props: Record<string, unknown>): Promise<string[]> => {
  const tree = {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["n1"] },
      { id: "n1", component, source: "prewired", props },
    ],
    queries: [],
  } as unknown as Tree;
  return (await catalogIssues(tree, undefined, [])).map((issue) => issue.message);
};

describe("an engine's own props are legal on the component that renders it", () => {
  it("lets a recharts prop through both gates", async () => {
    expect(await bespoke("Sparkline", { data: [1, 2, 3], stroke: "#FF3B30" })).toEqual([]);
    expect(tsc('<Sparkline data={[1, 2, 3]} stroke="#FF3B30" strokeWidth={3} />', "Sparkline")).toEqual([]);
  });

  it("lets a per-series color ride on one series descriptor", () => {
    expect(tsc(
      '<LineChart data={[]} xKey="month" series={[{ key: "revenue", stroke: "#FF3B30" }, "cost"]} />',
      "LineChart",
    )).toEqual([]);
  });

  it("lets a Base UI prop through on a component built from Base UI", () => {
    expect(tsc('<Input label="Amount" inputMode="decimal" />', "Input")).toEqual([]);
  });
});

describe("style is legal everywhere, and passthrough opens nothing else", () => {
  it("takes an inline style on a component that wraps no engine", async () => {
    expect(await bespoke("Stack", { gap: 8, style: { borderRadius: 12 } })).toEqual([]);
    expect(tsc('<Card title="Spend" style={{ borderRadius: 12, background: "#FFF7ED" }} />', "Card")).toEqual([]);
  });

  it("still refuses a misspelled prop on a component that wraps no engine", async () => {
    // The gate this feature must not cost: `data` for DataTable's `rows` is the
    // "valid table, empty rows" class, and it is still a blocking error.
    expect((await bespoke("DataTable", { data: [] })).join(" ")).toContain('sets unknown prop "data"');
    expect(tsc("<DataTable data={[]} />", "DataTable").join(" ")).toContain('sets unknown prop "data"');
    expect(tsc('<Button label="Go" onPress={() => undefined} />', "Button").join(" ")).toContain('unknown prop "onPress"');
  });
});
