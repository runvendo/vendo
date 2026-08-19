/**
 * The save-time gauntlet for a COMPONENT screen — five stages over the real
 * thing: real esbuild, the real acorn scan, the real TypeScript compiler, the
 * real VM, and the tree validators the wire artifact already ships.
 *
 * Two properties are worth more than the count of tests here:
 *
 *  1. EVERY REFUSAL TEACHES. These messages are read by a model repairing the
 *     screen, so each class is asserted on its sentence, not on its code.
 *  2. WHAT IT HANDS BACK BOOTS. The `compiled` + `queries` a passing check
 *     returns are exactly what the renderer re-boots the screen from
 *     (`packages/ui` use-screen.ts), so this file boots them and compares the
 *     paint against the `initialTree` the same check produced. A gauntlet whose
 *     output the engine could not run would pass every test that only read its
 *     verdict.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { JsonSchema } from "@vendoai/core";
import {
  bootScreen,
  flattenTree,
  KIT_COMPONENT_NAMES,
  warmScreenEngine,
} from "../../src/contract/index.js";
import {
  checkComponentScreen,
  reviewComponentScreenInput,
  screenName,
  type ComponentScreenCheck,
} from "../../src/server/checking/component-screen.js";
import { screenCatalog } from "../../src/server/checking/screen-typings.js";
import { nodeToolchain } from "../../src/server/checking/toolchain.js";
import type { HostToolInfo } from "../../src/server/checking/deps.js";

const pendingSchema: JsonSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          recipient: { type: "string" },
          amount_cents: { type: "number" },
          scheduled_for: { type: "string" },
        },
        required: ["id", "recipient", "amount_cents", "scheduled_for"],
        additionalProperties: false,
      },
    },
  },
  required: ["data"],
  additionalProperties: false,
};

/** One host component's DERIVED props schema, as composition hands it over. */
const netWorthSchema: JsonSchema = {
  type: "object",
  properties: { valueCents: { type: "number" }, series: { type: "array", items: { type: "number" } } },
  required: ["valueCents"],
  additionalProperties: false,
};

/** A tool whose input is rich enough to write every literal shape a query input
 *  may be written in. */
const searchInputSchema: JsonSchema = {
  type: "object",
  properties: {
    status: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    limit: { type: "number" },
    window: {
      type: "object",
      properties: { from: { type: "string" }, open: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const tools: readonly HostToolInfo[] = [
  {
    name: "list_pending_transfers",
    description: "Transfers waiting to go out",
    risk: "read",
    inputSchema: { type: "object", properties: { status: { type: "string" } }, additionalProperties: false },
    outputSchema: pendingSchema,
  },
  {
    name: "list_accounts",
    description: "The person's accounts",
    risk: "read",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_transfers",
    description: "Search transfers",
    risk: "read",
    inputSchema: searchInputSchema,
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
];

/** The names this host's surface renders — the Kit slice a screen here needs. */
const catalog = ["Stack", "Row", "Card", "Text", "Button", "Callout"];

const ROWS = {
  data: [
    { id: "tr_1", recipient: "Ada", amount_cents: 4_200, scheduled_for: "2026-02-01" },
    { id: "tr_2", recipient: "Bob", amount_cents: 900, scheduled_for: "2026-02-03" },
  ],
};

interface Ran {
  tool: string;
  input?: unknown;
}

const check = async (
  source: string,
  runQuery: (tool: string, input?: unknown) => Promise<unknown> = async () => ROWS,
): Promise<ComponentScreenCheck> => checkComponentScreen({ source, hostTools: tools, catalog, runQuery });

/** The refusal's sentences — a check that PASSED here is the test failing. */
const refusal = async (
  source: string,
  runQuery?: (tool: string, input?: unknown) => Promise<unknown>,
): Promise<{ codes: string[]; text: string; result: ComponentScreenCheck }> => {
  const result = await check(source, runQuery);
  if (result.ok) throw new Error("expected the gauntlet to refuse this screen");
  return {
    codes: result.issues.map(({ code }) => code),
    text: result.issues.map(({ message }) => message).join("\n"),
    result,
  };
};

const GOOD = `import { useState } from "react";
import { Button, Callout, Card, Row, Stack, Text, tools, useQuery } from "@vendo/screen";

export default function PendingTransfers() {
  const pending = useQuery("list_pending_transfers");
  const [confirming, setConfirming] = useState<string | null>(null);

  const cancel = async (id: string) => {
    await tools.cancel_transfer({ id });
    setConfirming(null);
  };

  return (
    <Stack gap={12}>
      <Text text="Transfers waiting to go out" variant="heading" />
      {pending.data.length === 0 ? <Text text="Nothing is waiting to go out." variant="caption" /> : null}
      {pending.data.map((transfer) => (
        <Card key={transfer.id} title={transfer.recipient}>
          <Row justify="between" align="center">
            <Stack gap={4}>
              <Text text={(transfer.amount_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} />
              <Text text={new Date(transfer.scheduled_for).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} variant="caption" />
            </Stack>
            <Button label="Cancel" variant="secondary" onClick={() => setConfirming(transfer.id)} />
          </Row>
          {confirming === transfer.id ? (
            <Callout tone="warning" title="Cancel this transfer?">
              <Button label="Yes, cancel it" variant="danger" onClick={() => cancel(transfer.id)} />
            </Callout>
          ) : null}
        </Card>
      ))}
    </Stack>
  );
}
`;

beforeAll(async () => {
  await warmScreenEngine();
});

describe("a screen that passes", () => {
  it("hands back the compiled screen, the query plan, the answers, and the paint", async () => {
    const ran: Ran[] = [];
    const result = await check(GOOD, async (tool, input) => {
      ran.push({ tool, ...(input === undefined ? {} : { input }) });
      return ROWS;
    });

    expect(result).toMatchObject({ ok: true, issues: [] });
    // The plan is read out of the file, and the check EXECUTES it — once per
    // tool, because the engine resolves one result per tool.
    expect(result.queryPlan).toEqual([{ tool: "list_pending_transfers" }]);
    expect(ran).toEqual([{ tool: "list_pending_transfers" }]);
    // The answers ride back because two things downstream cannot get them
    // anywhere else: the renderer boots the same screen, and the AI reviewer
    // judges the numbers on screen against them.
    expect(result.queries).toEqual({ list_pending_transfers: ROWS });
    expect(result.compiled).toContain("require(");
    expect(result.compiled).not.toContain("import {");
    // The paint is the flat tree, addressed by structural path — a keyed row's id
    // carries its key, so the renderer's React keys survive a repaint.
    expect(result.initialTree?.root).toBe("root");
    expect(Object.keys(result.initialTree?.nodes ?? {})).toContain("root.Card:tr_1");
    expect(result.initialTree?.nodes["root.Card:tr_1"]?.props).toEqual({ title: "Ada" });
  });

  it("hands back a compiled screen the ENGINE really runs, painting the tree it reported", async () => {
    const result = await check(GOOD);
    expect(result.ok).toBe(true);

    // The seam: this is what the renderer does with a served payload — boot the
    // compiled source on the served queries and flatten the paint. A `compiled`
    // in the wrong format, a `queries` keyed differently, or a catalog the engine
    // disagreed about would each show up right here and nowhere else.
    const screen = bootScreen({
      compiledSource: result.compiled ?? "",
      queries: result.queries ?? {},
      catalog,
      now: Date.UTC(2026, 1, 1),
    });
    try {
      const painted = flattenTree(screen.tree());

      expect(painted.root).toBe(result.initialTree?.root);
      expect(Object.keys(painted.nodes).sort()).toEqual(Object.keys(result.initialTree?.nodes ?? {}).sort());
      expect(painted.nodes["root.Card:tr_1"]).toEqual(result.initialTree?.nodes["root.Card:tr_1"]);

      // …and it is a LIVE screen, not a snapshot: the handler the tree names moves it.
      const handler = painted.nodes["root.Card:tr_1.0.1"]?.props.onClick as { $handler: string };
      expect(handler.$handler).toMatch(/^h\d+$/u);
      const fired = screen.fire(handler.$handler);
      expect(JSON.stringify(fired.tree)).toContain("Cancel this transfer?");
    } finally {
      screen.dispose();
    }
  });

  it("passes a screen with no queries at all, and runs nothing", async () => {
    const ran: Ran[] = [];
    const result = await check(`import { Stack, Text } from "@vendo/screen";

export default function Empty() {
  return <Stack gap={8}><Text text="Nothing to show yet." /></Stack>;
}
`, async (tool) => {
      ran.push({ tool });
      return ROWS;
    });

    expect(result.ok).toBe(true);
    expect(result.queryPlan).toEqual([]);
    expect(result.queries).toEqual({});
    expect(ran).toEqual([]);
  });

  it("executes a LITERAL query input, and reads one tool twice with the same input as one query", async () => {
    const ran: Ran[] = [];
    const result = await check(`import { Stack, Text, useQuery } from "@vendo/screen";

function Count() {
  const again = useQuery("list_pending_transfers", { status: "pending" });
  return <Text text={"again " + again.data.length} />;
}

export default function Twice() {
  const pending = useQuery("list_pending_transfers", { status: "pending" });
  return <Stack><Text text={"rows " + pending.data.length} /><Count /></Stack>;
}
`, async (tool, input) => {
      ran.push({ tool, input });
      return ROWS;
    });

    expect(result.ok).toBe(true);
    expect(result.queryPlan).toEqual([{ tool: "list_pending_transfers", input: { status: "pending" } }]);
    expect(ran).toEqual([{ tool: "list_pending_transfers", input: { status: "pending" } }]);
  });

  it("reads every shape a LITERAL input may be written in, and runs it verbatim", async () => {
    const ran: Ran[] = [];
    const result = await check(`import { Stack, Text, useQuery } from "@vendo/screen";

export default function Search() {
  const found = useQuery("search_transfers", {
    status: "pending",
    tags: ["urgent", "flagged"],
    limit: -5,
    window: { from: "2026-01-01", open: false },
  });
  return <Stack><Text text={String(found.data.length)} /></Stack>;
}
`, async (tool, input) => {
      ran.push({ tool, input });
      return ROWS;
    });

    expect(result.issues).toEqual([]);
    // Arrays, nested objects, booleans and a negative number all execute as the
    // JSON they are — the tool receives what the file says, not a reconstruction.
    expect(ran).toEqual([{
      tool: "search_transfers",
      input: { status: "pending", tags: ["urgent", "flagged"], limit: -5, window: { from: "2026-01-01", open: false } },
    }]);
  });
});

describe("stage 1 — it does not compile", () => {
  it("names the line and what a screen is", async () => {
    const { codes, text } = await refusal(`import { Text } from "@vendo/screen";
export default function S() { return <Text text="x" ; }
`);

    expect(codes).toEqual(["compile"]);
    expect(text).toContain("does not compile as TSX (line 2)");
    expect(text).toContain("a screen is one plain .tsx module: its imports, then one default-exported React component.");
  });
});

describe("stage 2 — the two rules a compiler cannot state", () => {
  it("refuses an import that is not react or the screen module", async () => {
    const { codes, text } = await refusal(`import { z } from "zod";
import { Text } from "@vendo/screen";
export default function S() { return <Text text={String(z)} />; }
`);

    expect(codes).toEqual(["import"]);
    expect(text).toContain('imports "zod"');
    expect(text).toContain('a screen may import only "react" (its hooks) and "@vendo/screen"');
    expect(text).toContain("There is no bundler and no node_modules here");
  });

  it("refuses a runtime import and a require", async () => {
    expect((await refusal(`import { Text } from "@vendo/screen";
export default function S() { const later = import("react"); return <Text text={String(later)} />; }
`)).text).toContain("loads a module at runtime with import(…)");

    expect((await refusal(`import { Text } from "@vendo/screen";
export default function S() { return <Text text={String(require("react"))} />; }
`)).text).toContain("calls require(…)");
  });

  it("refuses a query whose tool name is not written out", async () => {
    const { codes, text } = await refusal(`import { Text, useQuery } from "@vendo/screen";
const which = "list_pending_transfers";
export default function S() { const rows = useQuery(which); return <Text text={String(rows)} />; }
`);

    expect(codes).toEqual(["query-name"]);
    expect(text).toContain("calls useQuery(…) with a computed tool name");
    expect(text).toContain("executed BEFORE the component ever renders");
    // The repair names the tools that CAN be read.
    expect(text).toContain("The tools you can read are: list_pending_transfers, list_accounts, search_transfers.");
  });

  it("refuses a query that names no tool, and lists the host's tools", async () => {
    const { codes, text } = await refusal(`import { Text, useQuery } from "@vendo/screen";
export default function S() { return <Text text={String(useQuery("ghost_list"))} />; }
`);

    expect(codes).toEqual(["query-tool"]);
    expect(text).toContain('useQuery("ghost_list") names unknown tool "ghost_list"');
    expect(text).toContain("the host tools are: list_pending_transfers, list_accounts, search_transfers, cancel_transfer");
  });

  it("tells a screen with NO readable tool to say so, instead of listing tools it cannot read", async () => {
    // The field failure this closes: refused with a list of write-only tools,
    // the model invented a plausible read tool, failed five times, then shipped
    // a screen asserting there was no data above a table of that same data.
    const result = await checkComponentScreen({
      source: `import { Text, useQuery } from "@vendo/screen";
export default function S() { return <Text text={String(useQuery("invoices_list"))} />; }
`,
      hostTools: tools.filter(({ risk }) => risk !== "read"),
      catalog,
      runQuery: async () => ROWS,
    });
    if (result.ok) throw new Error("expected the gauntlet to refuse this screen");
    const text = result.issues.map(({ message }) => message).join("\n");
    expect(text).toContain("this product has NO tool a screen can read");
    expect(text).toContain("do not claim the data is missing or empty, which you cannot know");
    expect(text).toContain("<Disclaimer>");
    // The tools it CANNOT read are not offered as if they were an answer.
    expect(text).not.toContain("cancel_transfer");
  });

  it("refuses a query that WRITES, because a query runs on every render", async () => {
    const { codes, text } = await refusal(`import { Text, useQuery } from "@vendo/screen";
export default function S() { return <Text text={String(useQuery("cancel_transfer"))} />; }
`);

    expect(codes).toEqual(["query-tool"]);
    expect(text).toContain('reads with a tool that CHANGES things (risk "destructive")');
    expect(text).toContain("this would write every time the screen paints");
    expect(text).toContain("Call it from a handler as tools.cancel_transfer({ … })");
  });

  it("ADMITS a computed query input, and answers it from the paint that asked", async () => {
    // Nothing can resolve this before the component runs — the input is whatever
    // that render worked out. So the plan cannot hold it: the screen paints
    // `{ data: undefined }` there, NAMES the read it wanted, and the gate runs it
    // and paints again.
    const ran: Ran[] = [];
    const result = await check(`import { useState } from "react";
import { Text, useQuery } from "@vendo/screen";
export default function S() {
  const [status] = useState("pending");
  const rows = useQuery("list_pending_transfers", { status });
  return <Text text={rows.data === undefined ? "loading" : String(rows.data.length)} />;
}
`, async (tool, input) => {
      ran.push(input === undefined ? { tool } : { tool, input });
      return ROWS;
    });

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(ran).toEqual([{ tool: "list_pending_transfers", input: { status: "pending" } }]);
    // The read the paint asked for is in the plan the surface re-reads, keyed the
    // way the engine keys its data.
    expect(result.queryPlan).toEqual([{ tool: "list_pending_transfers", input: { status: "pending" } }]);
    expect(Object.keys(result.queries ?? {})).toEqual(['list_pending_transfers {"status":"pending"}']);
  });

  it("admits an input that only LOOKS literal, the same way", async () => {
    // A spread and a computed key are both computed, and none of the three is a
    // shape the scan can pre-run — so each is asked for by the paint instead.
    for (const input of ['{ ...defaults }', '{ [field]: "pending" }', '{ tags: ["a", , "b"] }']) {
      const result = await check(`import { Stack, Text, useQuery } from "@vendo/screen";
const defaults = { status: "pending" };
const field = "status";
export default function S() {
  const found = useQuery("search_transfers", ${input});
  return <Stack><Text text={String(found.data === undefined ? 0 : found.data.length)} /></Stack>;
}
`);
      expect(result.issues).toEqual([]);
      expect(result.queryPlan?.map(({ tool }) => tool)).toEqual(["search_transfers"]);
    }
  });

  it("ADMITS the same tool read with two DIFFERENT inputs — one result per ASK, not per tool", async () => {
    const result = await check(`import { Stack, Text, useQuery } from "@vendo/screen";
export default function S() {
  const pending = useQuery("list_pending_transfers", { status: "pending" });
  const sent = useQuery("list_pending_transfers", { status: "sent" });
  return <Stack><Text text={String(pending.data.length)} /><Text text={String(sent.data.length)} /></Stack>;
}
`, async (_tool, input) => ({ data: [{ id: (input as { status: string }).status }] }));

    expect(result.issues).toEqual([]);
    expect(result.queries).toEqual({
      'list_pending_transfers {"status":"pending"}': { data: [{ id: "pending" }] },
      'list_pending_transfers {"status":"sent"}': { data: [{ id: "sent" }] },
    });
  });

  it("reads one ask ONCE, however many times the screen writes it", async () => {
    const ran: Ran[] = [];
    const result = await check(`import { Stack, Text, useQuery } from "@vendo/screen";
export default function S() {
  const a = useQuery("list_pending_transfers", { status: "pending" });
  const b = useQuery("list_pending_transfers", { status: "pending" });
  return <Stack><Text text={String(a.data.length + b.data.length)} /></Stack>;
}
`, async (tool, input) => {
      ran.push({ tool, input });
      return ROWS;
    });

    expect(result.issues).toEqual([]);
    expect(ran).toHaveLength(1);
  });

  it("refuses more arguments than useQuery takes", async () => {
    const { text } = await refusal(`import { Text, useQuery } from "@vendo/screen";
export default function S() {
  const rows = useQuery("list_pending_transfers", { status: "pending" }, true);
  return <Text text={String(rows)} />;
}
`);

    expect(text).toContain("with 3 arguments — it takes the tool name and, at most, one input object");
  });

  it("refuses a tool call that names no tool", async () => {
    const { codes, text } = await refusal(`import { Button, tools } from "@vendo/screen";
export default function S() { return <Button label="go" onClick={() => tools.ghost_write({})} />; }
`);

    expect(codes).toEqual(["tool-name"]);
    expect(text).toContain('tools.ghost_write(…) names unknown tool "ghost_write"');
  });

  it("refuses a tool called while the component renders — a write with nobody clicking", async () => {
    const { codes, text } = await refusal(`import { Text, tools } from "@vendo/screen";
export default function S() {
  tools.cancel_transfer({ id: "tr_1" });
  return <Text text="cancelling" />;
}
`);

    expect(codes).toEqual(["tool-at-render"]);
    expect(text).toContain("while the component is rendering");
    expect(text).toContain("a write fires with nobody clicking");
    expect(text).toContain("onClick={() => tools.cancel_transfer({ … })}");
  });

  it("refuses computed and aliased access to tools", async () => {
    expect((await refusal(`import { Button, tools } from "@vendo/screen";
const which = "cancel_transfer";
export default function S() { return <Button label="go" onClick={() => tools[which]({ id: "tr_1" })} />; }
`)).text).toContain("uses computed member access on `tools`");

    const aliased = await refusal(`import { Button, tools } from "@vendo/screen";
export default function S() {
  const act = tools;
  return <Button label="go" onClick={() => act.cancel_transfer({ id: "tr_1" })} />;
}
`);
    expect(aliased.codes).toEqual(["tool-access"]);
    expect(aliased.text).toContain("aliases or passes the `tools` object around");
  });

  it("refuses a file with no default export, and one whose default is not a component", async () => {
    expect((await refusal(`import { Text } from "@vendo/screen";
export function Screen() { return <Text text="x" />; }
`)).text).toContain("exports no default — a screen is one file that default-exports its component");

    expect((await refusal(`import { Text } from "@vendo/screen";
const rows = [1, 2];
export default rows;
`)).text).toContain("default-exports something that is not a component");
  });

  it("accepts a default export written inline, named or not", async () => {
    for (const declaration of [
      "export default function Overview() { return <Stack><Text text=\"fine\" /></Stack>; }",
      "export default function () { return <Stack><Text text=\"fine\" /></Stack>; }",
      "export default () => <Stack><Text text=\"fine\" /></Stack>;",
    ]) {
      const result = await check(`import { Stack, Text } from "@vendo/screen";\n\n${declaration}\n`);
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it("accepts a default export that arrives through a name", async () => {
    // The other two forms a model writes constantly, and the reason the walk
    // follows an alias: esbuild rewrites BOTH of these into
    // `var stdin_default = Overview; export { stdin_default as default }`, so the
    // exported name reaches the component through one hop.
    for (const declaration of [
      "const Overview = () => <Stack><Text text=\"fine\" /></Stack>;\nexport default Overview;",
      "function Overview() { return <Stack><Text text=\"fine\" /></Stack>; }\nexport default Overview;",
    ]) {
      const result = await check(`import { Stack, Text } from "@vendo/screen";\n\n${declaration}\n`);
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
      // …and the app row's name is read off that same export.
      expect(screenName(declaration)).toBe("Overview");
    }
  });

  it("does not read the IMPORT block as tools usage", async () => {
    // `import { tools } from "@vendo/screen"` puts the name in expression
    // position, which the shipped literal-access scan would read as aliasing.
    const result = await check(`import { Button, Stack, tools } from "@vendo/screen";

export default function S() {
  return <Stack><Button label="Cancel" onClick={() => tools.cancel_transfer({ id: "tr_1" })} /></Stack>;
}
`);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("stops at the first stage that finds anything", async () => {
    // This screen breaks the import rule AND writes an HTML element. Fail-fast:
    // a repair round is never handed the consequences of a break it has not
    // fixed yet, so only the scan's finding is reported.
    const { codes, text } = await refusal(`import { z } from "zod";
import { Text } from "@vendo/screen";
export default function S() { return <img><Text text={String(z)} /></img>; }
`);

    expect(codes).toEqual(["import"]);
    expect(text).not.toContain("HTML element");
  });
});

describe("stage 3 — the real compiler, with no DOM", () => {
  it("refuses an HTML element that is not a display brick, and names the ones that are", async () => {
    const { codes, text } = await refusal(`import { Text } from "@vendo/screen";
export default function S() { return <img><Text text="x" /></img>; }
`);

    expect(codes).toEqual(["types"]);
    expect(text).toContain("line 2: writes the HTML element <img>");
    expect(text).toContain("The HTML a screen has is display-only: div, span, section");
    expect(text).toContain("Anything with behavior comes from \"@vendo/screen\": Stack, Row, Card, Text, Button, Callout.");
    // The closing tag is the same break; a repair list that says everything
    // twice reads as two problems.
    expect(text.match(/writes the HTML element/gu)).toHaveLength(1);
  });

  /**
   * `className` is a DIALECT, not a prop. A port carries the host's own classes —
   * that is the whole point of porting one — and a screen a model authored has no
   * such prop to write, so it cannot borrow the host's chrome even if it tries.
   * The tag surface stays an allowlist in both: nothing else joined it.
   */
  const CLASSED = `import { Text } from "@vendo/screen";
export default function S() { return <div className="maple-card rounded-lg"><Text text="x" /></div>; }
`;

  it("takes the host's className on a PORTED screen's display tag", async () => {
    const passing = await checkComponentScreen({
      source: CLASSED, hostTools: tools, catalog, runQuery: async () => ROWS, ported: true,
    });
    expect(passing.issues).toEqual([]);
    expect(passing.ok).toBe(true);
  });

  it("has no className at all in the dialect a MODEL authors", async () => {
    const { codes, text } = await refusal(CLASSED);
    expect(codes).toEqual(["types"]);
    expect(text).toContain("className");
  });

  /**
   * The splitter's `<button>` rewrite target. A ported Button is the host's own
   * button mechanically rewritten, so it carries exactly what the host tag
   * carried — its class, its inline style, and its children in place of
   * `label`. The model-authored dialect keeps Button as it was: `label`
   * required, no class, no style.
   */
  const HOST_BUTTON = `import { Button } from "@vendo/screen";
export default function S() {
  return <Button className="chip" style={{ height: 28 }} onClick={() => {}}>1W</Button>;
}
`;

  it("takes the host button's class, style and children on a PORTED screen's Button", async () => {
    const passing = await checkComponentScreen({
      source: HOST_BUTTON, hostTools: tools, catalog, runQuery: async () => ROWS, ported: true,
    });
    expect(passing.issues).toEqual([]);
    expect(passing.ok).toBe(true);
  });

  it("keeps Button label-required, class-free and style-free in the dialect a MODEL authors", async () => {
    const { codes } = await refusal(HOST_BUTTON);
    expect(codes).toEqual(["types"]);
  });

  /**
   * THE PROPS SLOT. A ported component's paint can depend on the props its host
   * call site passes — and a query runs before the screen renders, so nothing
   * in the source can carry them. The check paints with the props it is HANDED
   * (the host's own captured sampleProps; never invented), and a component
   * that paints nothing without props still refuses loudly rather than
   * shipping a screen that opens blank.
   */
  const PROPPED = `export default function S({ total }: { total?: number }) {
  if (total === undefined) return null;
  return <p>{total}</p>;
}
`;

  it("paints a props-dependent PORTED screen with the props it is handed", async () => {
    const passing = await checkComponentScreen({
      source: PROPPED, hostTools: tools, catalog, runQuery: async () => ROWS, ported: true,
      props: { total: 7 },
    });
    expect(passing.issues).toEqual([]);
    expect(passing.ok).toBe(true);
    expect(JSON.stringify(passing.initialTree)).toContain("7");
  });

  it("still refuses the same screen loudly when no props arrive", async () => {
    const refused = await checkComponentScreen({
      source: PROPPED, hostTools: tools, catalog, runQuery: async () => ROWS, ported: true,
    });
    expect(refused.ok).toBe(false);
    expect(refused.issues.map(({ message }) => message).join("\n")).toContain("painted nothing");
  });

  it("still refuses a prop no display tag has, in either dialect", async () => {
    const idProp = `import { Text } from "@vendo/screen";
export default function S() { return <div id="card"><Text text="x" /></div>; }
`;
    const { codes, text } = await refusal(idProp);
    expect(codes).toEqual(["types"]);
    expect(text).toContain("id");

    const ported = await checkComponentScreen({
      source: idProp, hostTools: tools, catalog, runQuery: async () => ROWS, ported: true,
    });
    expect(ported.ok).toBe(false);
  });

  it("refuses a style property the paint allowlist does not name, on a brick and on a Kit component alike", async () => {
    // The renderer drops these at paint (`safeStyle`, one door for every node).
    // Legal here, a screen compiled clean and then quietly did not paint what
    // it wrote — the "valid component, nothing happens" class this floor refuses.
    for (const element of [
      `<div style={{ backgroundImage: "url(https://evil/x)" }}><Text text="x" /></div>`,
      `<Card style={{ filter: "blur(4px)" }}><Text text="x" /></Card>`,
    ]) {
      const { codes } = await refusal(`import { Card, Text } from "@vendo/screen";
export default function S() { return ${element}; }
`);

      expect(codes).toEqual(["types"]);
    }
  });

  it("refuses a name that does not exist inside a screen", async () => {
    const { text } = await refusal(`import { Text } from "@vendo/screen";
export default function S() {
  fetch("/api/transfers");
  return <Text text="x" />;
}
`);

    expect(text).toContain('reads the name "fetch", which does not exist inside a screen');
    expect(text).toContain("there is no DOM, no window/document, no fetch, no timers and no process here");
  });

  it("refuses a component the screen never imported, and lists the ones it has", async () => {
    const { text } = await refusal(`import { Text } from "@vendo/screen";
export default function S() { return <Sidebar><Text text="x" /></Sidebar>; }
`);

    expect(text).toContain("renders <Sidebar>, which this screen never imported");
    expect(text).toContain("The components available are: Stack, Row, Card, Text, Button, Callout.");
  });

  it("refuses a member the screen module does not export", async () => {
    const { text } = await refusal(`import { Sidebar, Text } from "@vendo/screen";
export default function S() { return <Text text="x" />; }
`);

    expect(text).toContain("has no exported member 'Sidebar'");
    expect(text).toContain("The screen surface is useQuery, tools, and these components:");
  });

  it("refuses a tool payload the tool's own schema does not accept, and lists its keys", async () => {
    const { text } = await refusal(`import { Button, tools } from "@vendo/screen";
export default function S() {
  return <Button label="Cancel" onClick={() => tools.cancel_transfer({ ident: "tr_1" })} />;
}
`);

    expect(text).toContain("calls tools.cancel_transfer(…) with an input its schema does not accept");
    expect(text).toContain("Its input keys are: id (required: id).");
  });

  it("refuses a prop value the component's schema does not take", async () => {
    const { text } = await refusal(`import { Text } from "@vendo/screen";
export default function S() { return <Text text="x" variant="enormous" />; }
`);

    expect(text).toContain('prop "variant"');
    expect(text).toContain('"body" | "heading" | "caption" | "label"');
    // Said ONCE: the wire translator's sentence names its own locus, so prefixing
    // its `where` on top of it read `prop "variant" prop "variant" on <Text>`.
    expect(text).not.toContain('prop "variant" prop "variant"');
  });

  /**
   * AN INVENTED GLYPH. `<Icon>` paints an empty span for a name outside lucide's
   * set (`ui` kit/icon.tsx) rather than crashing, and the catalog no longer spends
   * ~575 tokens teaching the 200-odd names — so nothing warned a model off one and
   * nothing refused it: a blank where the screen said there was an icon, with every
   * gate green. The generated typings print the closed set, which makes the
   * compiler the refusal, with its own did-you-mean where the name is a near miss.
   */
  it("refuses an icon name lucide has not got, and takes a real one", async () => {
    const withIcon = (source: string) => checkComponentScreen({
      source,
      hostTools: tools,
      catalog: [...catalog, "Icon"],
      runQuery: async () => ROWS,
    });

    const invented = await withIcon(`import { Icon, Row } from "@vendo/screen";
export default function S() { return <Row><Icon name="invented-glyph" /></Row>; }
`);
    expect(invented.ok).toBe(false);
    expect(invented.issues.map(({ code }) => code)).toEqual(["types"]);
    // The PROP is named, so the repair knows what to rewrite.
    expect(invented.issues[0]?.message).toContain('prop "name" on <Icon>');

    // A near miss gets the compiler's own spelling suggestion — the whole reason
    // the set is a union of literals rather than a bespoke check.
    const near = await withIcon(`import { Icon, Row } from "@vendo/screen";
export default function S() { return <Row><Icon name="trash-3" /></Row>; }
`);
    expect(near.ok).toBe(false);
    expect(near.issues[0]?.message).toContain(`Did you mean '"trash"'?`);

    // …and a real name passes the whole gauntlet, so this narrows the vocabulary
    // and nothing else.
    const real = await withIcon(`import { Icon, Row } from "@vendo/screen";
export default function S() { return <Row><Icon name="credit-card" /></Row>; }
`);
    expect(real.issues).toEqual([]);
    expect(real.ok).toBe(true);
  });

  /**
   * A MISSPELLED TONE, by the same mechanism and for the same reason.
   *
   * `resolveTone` falls back to `neutral` for a word it does not know (`ui`
   * kit/tokens.ts) — deliberately, because a stored screen carrying an old spelling
   * must still render rather than crash. So `tone="sucess"` paints grey, which is a
   * valid-looking pill nothing downstream can question. The Kit's tone schema is a
   * zod enum, so the typings print it closed and the compiler is the refusal, with
   * its own did-you-mean; the runtime fallback stays where it is, for the documents
   * that need it.
   */
  it("refuses a tone the Kit's vocabulary has not got, and takes a real one", async () => {
    const withBadge = (source: string) => checkComponentScreen({
      source,
      hostTools: tools,
      catalog: [...catalog, "Badge"],
      runQuery: async () => ROWS,
    });

    const typo = await withBadge(`import { Badge, Row } from "@vendo/screen";
export default function S() { return <Row><Badge label="Paid" tone="sucess" /></Row>; }
`);
    expect(typo.ok).toBe(false);
    expect(typo.issues.map(({ code }) => code)).toEqual(["types"]);
    // The whole vocabulary is in the refusal, so the repair does not have to guess
    // it — and the near miss gets the compiler's own spelling suggestion, which is
    // the reason the set is a union of literals rather than a bespoke check.
    expect(typo.issues[0]?.message).toContain('"neutral" | "accent" | "info" | "success" | "warning" | "danger"');
    expect(typo.issues[0]?.message).toContain(`Did you mean '"success"'?`);

    // …and every word the vocabulary really has passes, including `info`, which is
    // a tone of its own now rather than an older spelling of neutral.
    for (const tone of ["neutral", "accent", "info", "success", "warning", "danger"]) {
      const real = await withBadge(`import { Badge, Row } from "@vendo/screen";
export default function S() { return <Row><Badge label="Paid" tone="${tone}" /></Row>; }
`);
      expect(real.issues, tone).toEqual([]);
    }
  }, 30_000);

  it("never reads `key` as a prop — a mapped row writes one, and the real fault is the one named", async () => {
    const mapped = (row: string) => checkComponentScreen({
      source: `import { DataTable, TableRow, Text, useQuery } from "@vendo/screen";
export default function S() {
  const pending = useQuery("list_pending_transfers");
  return (
    <DataTable rows={pending.data} columns={[{ key: "recipient", label: "To" }, { key: "amount_cents", label: "Amount" }]}>
      {pending.data.map((transfer) => (
        <TableRow key={transfer.id}>
          <Text text={transfer.recipient} />
          ${row}
        </TableRow>
      ))}
    </DataTable>
  );
}
`,
      hostTools: tools,
      catalog: [...catalog, "DataTable", "TableRow"],
      runQuery: async () => ROWS,
    });

    // The pattern the Kit prompt teaches, `key` and all.
    expect(await mapped('<Text text={(transfer.amount_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} />'))
      .toMatchObject({ ok: true, issues: [] });

    // …and where the KEYED element is broken, `key` must not be what the repair
    // is told about: it rides along in every element-level props error, and the
    // model would strip the one attribute React requires — losing the real fault,
    // which the compiler reports only once, on the same tag.
    const sentences = async (cell: string): Promise<string> =>
      (await mapped(cell)).issues.map(({ message }) => message).join("\n");
    for (const [broken, fault] of [
      ['<Text text="1" sparkle={true} />', 'sets unknown prop "sparkle"'],
      ["<Text text={transfer} />", 'prop "text" on <Text> takes string | number'],
    ] as const) {
      const keyed = await sentences(broken.replace("<Text ", "<Text key={transfer.id} "));
      expect(keyed).toContain(fault);
      expect(keyed).toBe(await sentences(broken));
    }
  });

  /** `key` is React's on EVERY element, brick and component alike — the format
   *  skill asks for one on every row a screen maps. TypeScript only intersects
   *  `JSX.IntrinsicAttributes` into a value-based element, never into an
   *  intrinsic tag, so declaring `key` there alone made `<li key={…}>` a TS2322
   *  that the translator then reported as the self-contradictory `prop "key" on
   *  <li> takes string | number, but this value is string`. Both spellings are
   *  asserted here because a fix that only moves the declaration would trade one
   *  half of the rule for the other. */
  it("takes `key` on a mapped row, on a display brick and on a Kit component alike", async () => {
    const result = await check(`import { Stack, Text } from "@vendo/screen";

const NAMES = ["ada", "bob"];

export default function Roster() {
  return (
    <Stack gap={8}>
      <ul>
        {NAMES.map((name) => <li key={name} style={{ padding: 4 }}>{name}</li>)}
      </ul>
      {NAMES.map((name) => <Text key={name} text={name} />)}
    </Stack>
  );
}
`);

    expect(result).toMatchObject({ ok: true, issues: [] });
    // …and the key REACHES the paint, so the renderer's React keys are the ones
    // the screen wrote rather than positions the next repaint reshuffles.
    const ids = Object.keys(result.initialTree?.nodes ?? {});
    expect(ids).toContain("root.0.li:ada");
    expect(ids).toContain("root.Text:bob");
  });

  it("refuses a field the tool's declared response does not carry, and names the real ones", async () => {
    const { text } = await refusal(`import { Text, useQuery } from "@vendo/screen";
export default function S() {
  const pending = useQuery("list_pending_transfers");
  return <Text text={String(pending.rows.length)} />;
}
`);

    expect(text).toContain('reads field "rows", which the tool\'s response shape does not carry');
    expect(text).toContain("the real fields are: data");
  });

  it("types a HOST component's props from the schema its entry carries", async () => {
    const withHost = (source: string) => checkComponentScreen({
      source,
      hostTools: tools,
      catalog: [...catalog, { name: "MapleNetWorthCard", propsJsonSchema: netWorthSchema }],
      runQuery: async () => ROWS,
    });

    const fine = await withHost(`import { MapleNetWorthCard, Stack } from "@vendo/screen";

export default function Overview() {
  return <Stack><MapleNetWorthCard valueCents={125000} series={[1, 2, 3]} /></Stack>;
}
`);
    expect(fine.issues).toEqual([]);
    expect(fine.ok).toBe(true);

    // A guessed prop on a host component is the one thing the skill promises will
    // not compile — and a NAME alone could not have caught it, because a
    // schema-less entry degrades every prop to `any`.
    const guessed = await withHost(`import { MapleNetWorthCard, Stack } from "@vendo/screen";

export default function Overview() {
  return <Stack><MapleNetWorthCard valueCents={125000} sparkline={[1, 2, 3]} /></Stack>;
}
`);
    expect(guessed.ok).toBe(false);
    expect(guessed.issues.map(({ code }) => code)).toEqual(["types"]);
    expect(guessed.issues[0]?.message).toContain("sparkline");
  });

  it("refuses a type-only import of a module that is not there", async () => {
    // Erased by the transform, so the scan never sees it — the compiler does.
    const { codes, text } = await refusal(`import type { Transfer } from "./transfers";
import { Stack, Text } from "@vendo/screen";

export default function S(): unknown {
  const rows: Transfer[] = [];
  return <Stack><Text text={String(rows.length)} /></Stack>;
}
`);

    expect(codes).toEqual(["types"]);
    expect(text).toContain("Cannot find module './transfers'");
    expect(text).toContain('A screen may import only "react" and "@vendo/screen".');
  });

  it("leaves a tool whose schema declares no properties open, rather than guessing", async () => {
    // An empty `properties` map declares nothing to check, and a gate that read it
    // as "takes no input" would refuse payloads the tool really accepts.
    const result = await check(`import { Button, tools } from "@vendo/screen";

export default function S() {
  return <Button label="Load" onClick={() => tools.list_accounts({ page: 2 })} />;
}
`);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("hands anything with no dialect of its own to the compiler's own sentence", async () => {
    const { codes, text } = await refusal(`import { Stack, Text } from "@vendo/screen";

export default function S() {
  const total: number = "not a number";
  return <Stack><Text text={String(total)} /></Stack>;
}
`);

    expect(codes).toEqual(["types"]);
    expect(text).toMatch(/^line 4: /u);
    expect(text).toContain("not assignable to type 'number'");
  });

  it("announces a construct it could not type, once, instead of going quietly dark", async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: unknown) => { warnings.push(String(message)); };
    try {
      const source = `import { Stack, Text } from "@vendo/screen";

export default function S() { return <Stack><Text text="fine" /></Stack>; }
`;
      // A catalog name that is not an identifier cannot be declared or imported,
      // so the gate stops checking it — and a silent hole is how a check rots.
      const options = { source, hostTools: tools, catalog: [...catalog, "Maple-Net-Worth"], runQuery: async () => ROWS };
      expect((await checkComponentScreen(options)).ok).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("could not be typed, so they are UNCHECKED");
      expect(warnings[0]).toContain('component "Maple-Net-Worth" is not an identifier');

      // Announced ONCE per process: a line on every screen is a line nobody reads.
      expect((await checkComponentScreen(options)).ok).toBe(true);
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = warn;
    }
  });

  it("leaves a tool with no declared output schema permissive rather than wrong", async () => {
    // A schema-less tool is legal, and a gate that guessed its shape would reject
    // working screens.
    const result = await check(`import { Text, useQuery } from "@vendo/screen";
export default function S() {
  const accounts = useQuery("list_accounts");
  return <Text text={String(accounts.whatever.deep.length)} />;
}
`, async () => ({ whatever: { deep: [1, 2] } }));

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("stage 4 — it runs the screen for real", () => {
  it("reports a query that failed when the check ran it", async () => {
    const { codes, text } = await refusal(GOOD, async () => {
      throw new Error("the ledger is unavailable");
    });

    expect(codes).toEqual(["run"]);
    expect(text).toContain('the query useQuery("list_pending_transfers") failed when this check ran it: the ledger is unavailable');
    expect(text).toContain("a screen may only read a tool that answers");
  });

  it("names the input in the sentence when the failing query had one", async () => {
    const { text } = await refusal(`import { Text, useQuery } from "@vendo/screen";
export default function S() {
  const rows = useQuery("list_pending_transfers", { status: "pending" });
  return <Text text={String(rows.data.length)} />;
}
`, async () => {
      throw new Error("bad status");
    });

    expect(text).toContain('useQuery("list_pending_transfers", {"status":"pending"}) failed');
  });

  it("catches a screen that throws on the data its queries REALLY returned", async () => {
    // The type check passed: the declared schema says `data` is always there. The
    // tool answered with an empty object, and only executing it finds that out.
    const { codes, text } = await refusal(GOOD, async () => ({}));

    expect(codes).toEqual(["run"]);
    expect(text).toContain("the screen threw while rendering against the data its queries really returned");
    expect(text).toContain("guard an undefined or empty result before .map/.reduce and render an empty state instead");
  });

  /**
   * The bench's `buildlog/failure-log`, replayed.
   *
   * A screen read one query with a LITERAL input and a second with an input it
   * computed off the first, then wrote `stages.data` raw. The computed read has no
   * answer on the first paint — that is what the supply loop is for — and reading
   * a field off it threw `cannot read property 'data' of undefined` before the
   * host ever got to answer, so the screen was thrown away for a paint it was
   * never given the data for.
   *
   * Two laws close it. A miss is an OBJECT now
   * (`genui/component/vm-program.ts` `MISS`), so `.data` on a pending read yields
   * `undefined` instead of throwing; and a paint that throws while it is STILL
   * waiting on a read is a loading paint, so the loop answers what it named and
   * paints again rather than recording the throw. Together they cover every shape
   * — `.length`, `.map`, `.find` — because none of them is reached on the paint
   * that matters.
   *
   * What is still a refusal: a throw with nothing outstanding, and a throw on the
   * last bounded round, where there is no next paint to be judged on.
   */
  const withTable = async (source: string): Promise<ComponentScreenCheck> => checkComponentScreen({
    source,
    hostTools: tools,
    catalog: [...catalog, "DataTable"],
    runQuery: async () => ROWS,
  });

  const PENDING_READ = (shown: string): string => `import { useState } from "react";
import { DataTable, Stack, Text, useQuery } from "@vendo/screen";

export default function BuildDetail() {
  const all = useQuery("search_transfers", { status: "pending" });
  const rows = all.data;
  const [chosen, setChosen] = useState(rows[0]?.id);
  const detail = useQuery("search_transfers", { status: chosen });
  return (
    <Stack gap={8}>
      <DataTable rows={rows} columns={["recipient"]} rowActions={(row) => <Text text={String(setChosen)} />} />
      ${shown}
    </Stack>
  );
}
`;

  it("paints a read whose answer has not arrived yet, and hands its data to the Kit", async () => {
    const result = await withTable(PENDING_READ(`<DataTable rows={detail.data} columns={["recipient"]} />`));

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    // The loop answered the computed read and painted again, so the plan grew.
    expect(result.queryPlan).toEqual([
      { tool: "search_transfers", input: { status: "pending" } },
      { tool: "search_transfers", input: { status: "tr_1" } },
    ]);
  });

  it("paints the whole failure-log case — the raw `.data` AND the `.length` on it", async () => {
    // The artifact's own second half, verbatim in shape: `.length` on a read that
    // has not landed. The first paint throws on it; the loop answers the read it
    // named and the second paint has real rows, so the screen the person sees is
    // the one that works.
    const result = await withTable(PENDING_READ(`<Text text={detail.data.length + " shown"} />`));

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.queryPlan).toEqual([
      { tool: "search_transfers", input: { status: "pending" } },
      { tool: "search_transfers", input: { status: "tr_1" } },
    ]);
    // And it painted the REAL count, not an empty shell: the loading paint was
    // thrown away, not shown.
    const texts = Object.values(result.initialTree?.nodes ?? {}).map((node) => node.props?.text);
    expect(texts).toContain("2 shown");
  });

  it("keeps a throw with nothing outstanding a refusal, on the FIRST round", async () => {
    // Every read this screen makes is in the plan, so the first paint had
    // everything it asked for — the tool simply answered an envelope with no
    // `data` in it. Nothing is outstanding, so there is nothing to wait for: the
    // throw is the screen's own and the loop does not go round again.
    let asked = 0;
    const result = await check(GOOD, async () => {
      asked += 1;
      return {};
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(["run"]);
    expect(result.issues[0]?.message).toContain("guard an undefined or empty result before .map/.reduce");
    expect(asked).toBe(1);
  });

  it("stops at the bound — a paint that keeps asking and keeps throwing is refused", async () => {
    // A loading paint may not be forever: a screen that names a NEW read every
    // time it throws would loop, so the last round's throw is the verdict. The
    // paint is faked because no real screen diverges here — a gate round is a
    // fresh boot, so a real one converges on the second — and what needs pinning
    // is the loop, not a pathological screen.
    let asked = 0;
    let painted = 0;
    const result = await checkComponentScreen({
      source: GOOD,
      hostTools: tools,
      catalog,
      runQuery: async () => {
        asked += 1;
        return ROWS;
      },
      toolchain: {
        ...nodeToolchain(),
        paint: async () => {
          painted += 1;
          return {
            ok: false,
            kind: "render",
            message: `still waiting, round ${painted}`,
            misses: [{ tool: "search_transfers", input: { status: String(painted) } }],
          };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(["run"]);
    // The LAST round's message, and three rounds, never a fourth.
    expect(result.issues[0]?.message).toContain("still waiting, round 3");
    expect(painted).toBe(3);
    expect(asked).toBe(3);
  });

  it("relays a screen that would not paint, and one that would not stop", async () => {
    const nothing = await refusal(`import { Text } from "@vendo/screen";
export default function S() { return null; }
`);
    expect(nothing.codes).toEqual(["run"]);
    expect(nothing.text).toContain("the screen would not paint: this screen painted nothing — it returned null");
    // Relayed verbatim: the engine writes these to be read by whatever repairs
    // the screen, so a second sentence of advice would only repeat it.
    expect(nothing.text).not.toContain("the component must render for every answer");

    const runaway = await refusal(`import { Text } from "@vendo/screen";
export default function S() {
  while (true) {}
  return <Text text="never" />;
}
`);
    expect(runaway.text).toContain("the screen would not paint: this screen did not finish inside");
  });

  it("renders with a clock, because the surface does", async () => {
    // A gate stricter than production would block screens that work.
    const result = await check(`import { Stack, Text } from "@vendo/screen";
export default function S() {
  const year = new Date().getUTCFullYear();
  return <Stack><Text text={"year " + year} /></Stack>;
}
`);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("keeps what it already had when it refuses late", async () => {
    // A refusal at the scan has the compiled screen; one at the type check has
    // the plan too; one at stage 4 has both. Nothing pretends to a paint.
    const scan = await refusal(`import { z } from "zod";
import { Text } from "@vendo/screen";
export default function S() { return <Text text={String(z)} />; }
`);
    expect(scan.result.compiled).toBeDefined();
    expect(scan.result.queryPlan).toBeUndefined();

    const types = await refusal(`import { Text, useQuery } from "@vendo/screen";
export default function S() {
  const pending = useQuery("list_pending_transfers");
  return <Text text={String(pending.rows)} />;
}
`);
    expect(types.result.queryPlan).toEqual([{ tool: "list_pending_transfers" }]);
    expect(types.result.initialTree).toBeUndefined();
    expect(types.result.queries).toBeUndefined();
  });
});

describe("stage 5 — the tree the screen painted", () => {
  it("refuses a paint past the format's own node cap", async () => {
    const { codes, text } = await refusal(`import { Stack, Text } from "@vendo/screen";

export default function Everything() {
  const rows = [];
  for (let index = 0; index < 5200; index += 1) rows.push(index);
  return <Stack>{rows.map((index) => <Text key={index} text={"row " + index} />)}</Stack>;
}
`);

    // The cap is the format's own number (core's TREE_MAX_NODES), counted INSIDE
    // the VM before the JSON crosses — so the refusal now arrives from the run,
    // one stage before the tree check that used to catch it.
    expect(codes).toEqual(["run"]);
    expect(text).toContain("the screen would not paint");
    expect(text).toContain("more than 5000 nodes");
  });

  /** Wide enough to write a chart, a table and a slot. Its own list because the
   *  shared catalog is pinned verbatim by the sentences that enumerate it. */
  const kitCatalog = [...catalog, "Accordion", "Badge", "DataTable", "EnumBadge", "LineChart", "Sparkline", "Stat", "Tabs", "Tooltip"];

  const painted = async (source: string): Promise<ComponentScreenCheck> =>
    checkComponentScreen({ source, hostTools: tools, catalog: kitCatalog, runQuery: async () => ROWS });

  it("refuses a node nested inside a component that renders no children", async () => {
    // The renderer hands `children` to every node it renders, so this caption
    // has always painted as nothing: the model wrote it, the person got a blank.
    const result = await painted(`import { LineChart, Stack, Text } from "@vendo/screen";

export default function Trend() {
  return (
    <Stack>
      <LineChart data={[{ month: "Jan", amount: 1 }]} xKey="month" series={["amount"]}>
        <Text text="Scheduled outflow" />
      </LineChart>
    </Stack>
  );
}
`);

    expect(result.ok).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(["nesting"]);
    const message = result.issues[0]?.message ?? "";
    expect(message).toContain("nests 1 node inside <LineChart>, which renders nothing nested inside it");
    expect(message).toContain("that content never reaches the screen");
    // …and it says where the caption goes instead.
    expect(message).toContain("Put it beside <LineChart> in a <Stack>, or give <LineChart> what it showed through its own props.");
  });

  it("counts a run of text as nesting too — a blank is a blank", async () => {
    const result = await painted(`import { Badge, Stack } from "@vendo/screen";

export default function Label() {
  return <Stack><Badge label="Beta">and a note</Badge></Stack>;
}
`);

    expect(result.issues.map(({ code }) => code)).toEqual(["nesting"]);
    expect(result.issues[0]?.message).toContain("nests 1 node inside <Badge>");
  });

  /** A control in a cell was refused by a per-slot vocabulary for as long as the
   *  slots existed. It renders, so the gauntlet takes it: where a control belongs
   *  is design, graded by the judge, not bookkeeping enforced by a list. */
  it("admits a control in a cell slot", async () => {
    const result = await painted(`import { Button, DataTable, tools } from "@vendo/screen";

export default function Ledger() {
  return (
    <DataTable
      rows={[{ id: "tr_1", status: "paid" }]}
      columns={[{ key: "status", cell: <Button label="Cancel" onClick={() => tools.cancel_transfer({ id: "tr_1" })} /> }]}
    />
  );
}
`);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /**
   * A PER-ROW slot written as a function of the row — the natural React form, and
   * for a year the one thing that could not work: a function prop serialized as a
   * single `$handler` door, so the table was handed a callback where an element
   * belongs and the column painted blank. The VM calls it now, once per row
   * (vm-program.ts `emitSlot`), so the compiler admits it and the paint proves
   * it: two rows, two amounts, each computed from its own row.
   */
  it("admits a per-row cell written as a function of the row", async () => {
    const result = await painted(`import { DataTable, Text } from "@vendo/screen";

export default function Ledger() {
  return (
    <DataTable
      rows={[{ id: "tr_1", amount: 4200 }, { id: "tr_2", amount: 900 }]}
      columns={[{ key: "amount", label: "Amount", cell: (row) => <Text text={(row.amount / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} /> }]}
    />
  );
}
`);

    expect(result.issues).toEqual([]);
    const table = Object.values(result.initialTree?.nodes ?? {}).find(({ component }) => component === "DataTable");
    const cells = (table?.props.columns as Array<{ cell: Array<{ props: { text: string } }> }>)[0]!.cell;
    expect(cells.map(({ props }) => props.text)).toEqual(["$42.00", "$9.00"]);
  });

  /** EVERY slot, not just a per-row one: `Tabs.tabs[].content`,
   *  `Accordion.items[].content` and `Tooltip.content` are painted ONCE, so their
   *  function takes no arguments — and for as long as only the per-row slots could
   *  be functions, the same reflex one component over crossed as a `$handler` and
   *  painted nothing. One screen, all three, one element apiece. */
  it("admits a function in the slots painted ONCE, and paints what it returns", async () => {
    const result = await painted(`import { Accordion, Tabs, Text, Tooltip } from "@vendo/screen";

export default function Panels() {
  return (
    <Tabs tabs={[{ label: "Queued", content: () => <Text text="none" /> }]}>
      <Accordion items={[{ label: "Terms", content: () => <Text text="terms" /> }]} />
      <Tooltip content={() => <Text text="hint" />}><Text text="?" /></Tooltip>
    </Tabs>
  );
}
`);

    expect(result.issues).toEqual([]);
    const nodes = Object.values(result.initialTree?.nodes ?? {});
    const slotText = (component: string, read: (props: Record<string, unknown>) => unknown): unknown =>
      (read(nodes.find((node) => node.component === component)!.props) as { props: { text: string } }).props.text;
    expect(slotText("Tabs", (props) => (props.tabs as Array<{ content: unknown }>)[0]!.content)).toBe("none");
    expect(slotText("Accordion", (props) => (props.items as Array<{ content: unknown }>)[0]!.content)).toBe("terms");
    expect(slotText("Tooltip", (props) => props.content)).toBe("hint");
  });

  /** The arity is the line the compiler still draws: a slot painted once is called
   *  with NOTHING, so a function of the row written in one would read a field off
   *  `undefined`. It is the only refusal left in this class, and it says which
   *  arity the slot wanted. */
  it("refuses a function OF THE ROW in a slot painted once", async () => {
    const result = await painted(`import { Text, Tooltip } from "@vendo/screen";

export default function Panels() {
  return <Tooltip content={(row) => <Text text={row.label} />}><Text text="?" /></Tooltip>;
}
`);

    expect(result.issues.map(({ code }) => code)).toEqual(["types"]);
    const message = result.issues[0]?.message ?? "";
    expect(message).toContain('in the "content" slot');
    expect(message).toContain("this slot is painted once, so it holds ELEMENTS, or a function of NO arguments");
  });

  /**
   * A KEY the item has not got is not a value in a slot.
   *
   * A Kit item type prints inline (`{ key: string; …; cell?: VendoSlot }`), so
   * the compiler's excess-property sentence NAMES the slot alias while having
   * nothing to do with a slot. Read as a slot error, a screen that wrote
   * `{ label, field }` into a KeyValue was told four times to "write the element
   * itself" — which it already had — while the real repair, that the item takes
   * `key` and `cell`, was in no sentence it received. It shipped a document that
   * does not render.
   */
  it("names the keys an item accepts when a screen writes one it has not got", async () => {
    const result = await checkComponentScreen({
      source: `import { KeyValue, Text, useQuery } from "@vendo/screen";

export default function Receipt() {
  const pending = useQuery("list_pending_transfers");
  const transfer = pending.data[0];
  return (
    <KeyValue
      record={transfer}
      items={[
        { label: "Recipient", field: <Text text={transfer.recipient} /> },
        { label: "Amount", field: <Text text={String(transfer.amount_cents / 100)} /> },
      ]}
    />
  );
}
`,
      hostTools: tools,
      catalog: [...kitCatalog, "KeyValue"],
      runQuery: async () => ROWS,
    });

    expect(result.issues.map(({ code }) => code)).toEqual(["types", "types"]);
    const message = result.issues[0]?.message ?? "";
    // The key it wrote, where it wrote it, and the keys that would have worked —
    // the same shape a misspelled tool payload key gets.
    expect(message).toContain('writes the key "field", which items on <KeyValue> does not accept');
    expect(message).toContain("Its keys are: key, label, cell (required: key)");
    // …and NOT the slot sentence, which named no key at all.
    expect(message).not.toContain("this slot is painted once");
  });

  /** The same misreading one step further out: a list written as a single
   *  object names the slot alias too, because the item type prints inline INSIDE
   *  the array type. Read as a slot error it produced an exact-fix line for
   *  `key:` — a repair the gate would have applied to the one field the item
   *  requires, over a screen whose real mistake was the shape of `items`. */
  it("does not read a mis-shaped list as a value in a slot", async () => {
    const result = await checkComponentScreen({
      source: `import { KeyValue, useQuery } from "@vendo/screen";

export default function Receipt() {
  const pending = useQuery("list_pending_transfers");
  return <KeyValue record={pending.data[0]} items={{ key: "recipient", label: "Recipient" }} />;
}
`,
      hostTools: tools,
      catalog: [...kitCatalog, "KeyValue"],
      runQuery: async () => ROWS,
    });

    const [{ code, message }] = result.issues as [{ code: string; message: string }];
    expect(code).toBe("types");
    expect(message).not.toContain("this slot is painted once");
  });

  /**
   * The CHANGE HANDLER class: the one refusal that computes the exact attribute a
   * screen was owed. Pinned as a shape rather than as prose because a repair a
   * reader can paste is the whole difference between one round and five.
   */
  const CHANGE_HANDLER = /^line (\d+): .*: (\w+)=\{(\(e\) => \w+\(e\.target\.(?:value|checked)\))\}\.$/u;

  const controls = [...kitCatalog, "Select", "Checkbox", "DateRange"];
  const control = async (source: string): Promise<ComponentScreenCheck> =>
    checkComponentScreen({ source, hostTools: tools, catalog: controls, runQuery: async () => ROWS });

  /**
   * `onChange={setClient}` is the React reflex, and the one shape a Kit control
   * cannot honor: it is called with the EVENT, so the setter stores
   * `{ target: { value } }` and the control renders that object. Nothing at
   * runtime tells a one-argument setter from a one-argument handler, so the
   * component cannot forgive this — the checker computes the repair instead.
   */
  it("computes the handler a change prop was owed, and prints it as the whole attribute", async () => {
    const result = await control(`import { useState } from "react";
import { Select, Stack, Text } from "@vendo/screen";

export default function Picker() {
  const [client, setClient] = useState("");
  return (
    <Stack gap={8}>
      <Select label="Client" options={["Ada", "Bob"]} onChange={setClient} />
      <Text text={client} />
    </Stack>
  );
}
`);

    const [{ code, message }] = result.issues as [{ code: string; message: string }];
    expect(code).toBe("types");
    expect(message).toContain("writes the state setter setClient where a handler goes");
    expect(message).toContain("is called with the change EVENT");
    // The repair is the checker's own bytes, in the shape the gate applies.
    const found = CHANGE_HANDLER.exec(message);
    expect(found?.[2]).toBe("onChange");
    expect(found?.[3]).toBe("(e) => setClient(e.target.value)");
  });

  /** Which FIELD of the event is read is the setter's own answer: a boolean
   *  comes off `checked`. Printing `value` there would trade one refusal for
   *  another on the fixed bytes. */
  it("reads a boolean setter off checked, not off value", async () => {
    const result = await control(`import { useState } from "react";
import { Checkbox, Stack } from "@vendo/screen";

export default function Filter() {
  const [paid, setPaid] = useState(false);
  return (
    <Stack gap={8}>
      <Checkbox label="Include paid" checked={paid} onChange={setPaid} />
    </Stack>
  );
}
`);

    expect(CHANGE_HANDLER.exec(result.issues[0]?.message ?? "")?.[3]).toBe("(e) => setPaid(e.target.checked)");
  });

  /** The same mistake one step in: an arrow that only passes its parameter on.
   *  The repair keeps the screen's own parameter and reads the field off it —
   *  and it is NOT the shape the gate applies, because only the screen knows
   *  what else its body was for. */
  it("prints the arrow a screen wrote, reading the value off its own parameter", async () => {
    const result = await control(`import { useState } from "react";
import { Select, Stack, Text } from "@vendo/screen";

export default function Picker() {
  const [client, setClient] = useState("");
  return (
    <Stack gap={8}>
      <Select label="Client" options={["Ada", "Bob"]} onChange={(val) => setClient(val)} />
      <Text text={client} />
    </Stack>
  );
}
`);

    const message = result.issues[0]?.message ?? "";
    expect(message).toContain("passes val on as a value");
    expect(message).toContain("Read the value off the event: (val) => setClient(val.target.value).");
    expect(CHANGE_HANDLER.test(message)).toBe(false);
  });

  /**
   * The boundary. `onClick` has the SAME declared handler type and no value at
   * all, and a range picker reports `{start, end}` rather than a field of the
   * event — so a repair reading `e.target.value` into either would be invented,
   * not computed. Both keep the plain type sentence.
   */
  it("invents no repair where the event carries no value the receiver could take", async () => {
    const clicked = await control(`import { Button, Stack, tools } from "@vendo/screen";

export default function Ledger() {
  const cancel = async (id: string) => { await tools.cancel_transfer({ id }); };
  return <Stack gap={8}><Button label="Cancel" onClick={cancel} /></Stack>;
}
`);
    const ranged = await control(`import { useState } from "react";
import { DateRange, Stack } from "@vendo/screen";

export default function Window() {
  const [range, setRange] = useState({ start: "", end: "" });
  return <Stack gap={8}><DateRange label="When" onChange={setRange} /></Stack>;
}
`);

    for (const { message } of [...clicked.issues, ...ranged.issues]) {
      expect(message).toContain("bind a value whose type matches the prop");
      expect(message).not.toContain("Read the value off the event");
      expect(CHANGE_HANDLER.test(message)).toBe(false);
    }
    expect(clicked.issues).toHaveLength(1);
    expect(ranged.issues).toHaveLength(1);
  });

  /** A field description written as the bare KEY — the shorthand `Select.options`
   *  already takes. `items` given `string[]` was a whole class of looped repairs;
   *  the type is the union now, so there is nothing left to refuse. */
  it("passes a column, a card field and a KeyValue item written as bare keys", async () => {
    const result = await checkComponentScreen({
      source: `import { CardList, DataTable, KeyValue, Stack, useQuery } from "@vendo/screen";

export default function Ledger() {
  const pending = useQuery("list_pending_transfers");
  return (
    <Stack gap={12}>
      <DataTable rows={pending.data} columns={["recipient", { key: "amount_cents", label: "Amount" }]} />
      <CardList items={pending.data} fields={["recipient"]} />
      <KeyValue record={pending.data[0]} items={["recipient", "scheduled_for"]} />
    </Stack>
  );
}
`,
      hostTools: tools,
      catalog: [...kitCatalog, "CardList", "KeyValue"],
      runQuery: async () => ROWS,
    });

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /** The new arrangement, through the whole gauntlet: a screen may put two panes
   *  side by side, and the panes are ordinary children. */
  it("passes two panes side by side", async () => {
    const result = await checkComponentScreen({
      source: `import { DataTable, KeyValue, SplitPane, useQuery } from "@vendo/screen";

export default function Ledger() {
  const pending = useQuery("list_pending_transfers");
  return (
    <SplitPane size={280}>
      <DataTable rows={pending.data} columns={["recipient"]} />
      <KeyValue record={pending.data[0]} items={["recipient"]} />
    </SplitPane>
  );
}
`,
      hostTools: tools,
      catalog: [...kitCatalog, "KeyValue", "SplitPane"],
      runQuery: async () => ROWS,
    });

    expect(result.issues).toEqual([]);
    expect(Object.values(result.initialTree?.nodes ?? {}).map((node) => node.component)).toContain("SplitPane");
  });

  /** Tooltip's `content` is documented as "code-only: Kit elements rendered as
   *  the hint instead of label", and `SLOTS` carried no entry for it — so the
   *  one shape the prop teaches was refused by the tree check while the Kit
   *  component painted it perfectly well (`ui` feedback/tooltip.tsx `content ??
   *  label`). The registry was the bug; the doc is the contract. */
  it("passes an element in Tooltip's content — the slot its own prop documents", async () => {
    const result = await painted(`import { Text, Tooltip } from "@vendo/screen";

export default function Hint() {
  return <Tooltip content={<Text text="Sent 3 days ago" />}><Text text="?" /></Tooltip>;
}
`);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /** The walk goes all the way DOWN a slot: what a cell holds has children of its
   *  own, and a component that renders none of them drops them just as silently
   *  there as at the top of the tree. */
  it("follows a childless component nested INSIDE a slot", async () => {
    const result = await painted(`import { DataTable, LineChart, Stack, Text } from "@vendo/screen";

export default function Ledger() {
  return (
    <DataTable
      rows={[{ id: "tr_1", status: "paid" }]}
      columns={[{ key: "status", cell: (row) => <Stack><LineChart data={[{ m: "Jan", v: 1 }]} xKey="m" series={["v"]}><Text text={row.status} /></LineChart></Stack> }]}
    />
  );
}
`);

    expect(result.issues.map(({ code }) => code)).toEqual(["nesting"]);
    expect(result.issues[0]?.message).toContain('prop "columns[0].cell[0].children[0]" nests 1 node inside <LineChart>');
  });

  /** A display brick is not a Kit component, and the renderer resolves a slot's
   *  element from both registries (`packages/ui` renderer.tsx `reifyElement`), so
   *  a brick in a cell renders and the floor takes it. Whole gauntlet, real
   *  compiler. */
  it("passes a display brick in a per-row cell", async () => {
    const result = await painted(`import { DataTable, Text } from "@vendo/screen";

export default function Invoices() {
  return (
    <DataTable
      rows={[{ id: "r1", status: "past_due" }]}
      columns={[{ key: "status", cell: (row) => <div style={{ display: "flex" }}><Text text={row.status} /></div> }]}
    />
  );
}
`);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("refuses a cell written on a ROW — the table reads columns[].cell and nothing else", async () => {
    // Whole gauntlet, real compiler. The VM stamps this element exactly as it
    // stamps a column's, so matching the bare key admitted a `cell` the table
    // never looks at: green all the way through, blank on the screen.
    const result = await painted(`import { Badge, DataTable } from "@vendo/screen";

export default function Invoices() {
  return (
    <DataTable
      rows={[{ id: "r1", cell: <Badge label="late" /> }]}
      columns={[{ key: "id" }]}
    />
  );
}
`);

    expect(result.issues.map(({ code }) => code)).toEqual(["nesting"]);
    const message = result.issues[0]?.message ?? "";
    expect(message).toContain('prop "rows[0].cell" holds <Badge>');
    expect(message).toContain('"rows[].cell" is not a slot');
    expect(message).toContain("the slots on <DataTable> are: columns[].cell");
  });

  it("follows a slot's component into its OWN contract — a slot is not a blind spot", async () => {
    // A Sparkline is legal in a cell, so the outer check passed and stopped
    // there. It renders nothing nested inside it, and the compiler cannot say
    // so — every Kit component's typings carry `children?: any` — so this note
    // reached the renderer and vanished. The nesting check is its only reader.
    const result = await painted(`import { DataTable, Sparkline } from "@vendo/screen";

export default function Invoices() {
  return (
    <DataTable
      rows={[{ id: "r1" }]}
      columns={[{ key: "id", cell: <Sparkline data={[1, 2, 3]}>trend</Sparkline> }]}
    />
  );
}
`);

    expect(result.issues.map(({ code }) => code)).toEqual(["nesting"]);
    const message = result.issues[0]?.message ?? "";
    expect(message).toContain('prop "columns[0].cell" nests 1 node inside <Sparkline>');
    expect(message).toContain("renders nothing nested inside it");
  });

  it("reads the sigil, not the shape — row data that describes a component is data", async () => {
    // A "cell" column whose value happens to name a component and carry a
    // children list. The VM stamps `$element` on what a screen wrote as an
    // ELEMENT and on nothing else, and the renderer reifies on exactly that
    // sigil — so this paints as text, and refusing it as a mis-nested cell
    // would block an app over data the rule never governs.
    const result = await painted(`import { DataTable } from "@vendo/screen";

export default function Inventory() {
  return (
    <DataTable
      rows={[{ id: "r1", cell: { component: "Button", children: [] } }]}
      columns={[{ key: "id" }]}
    />
  );
}
`);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("passes a legal slot and a legal nest — the rule is not a blanket ban", async () => {
    // The negative case is what proves it: a value component in a cell reads its
    // row by name, and <Stat> is one of the components that DOES render children.
    const result = await painted(`import { DataTable, EnumBadge, Sparkline, Stack, Stat } from "@vendo/screen";

export default function Ledger() {
  return (
    <Stack>
      <Stat label="Paid" value={12}>
        <Sparkline data={[1, 2, 3]} />
      </Stat>
      <DataTable
        rows={[{ id: "tr_1", status: "paid" }]}
        columns={[{ key: "status", cell: (row) => <EnumBadge value={row.status} /> }]}
      />
    </Stack>
  );
}
`);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("stage 6 — it presses what the screen painted", () => {
  const pressable = [...catalog, "Form", "Input", "Modal"];

  const pressed = async (
    source: string,
    runQuery: (tool: string, input?: unknown) => Promise<unknown> = async () => ROWS,
  ): Promise<ComponentScreenCheck> =>
    checkComponentScreen({ source, hostTools: tools, catalog: pressable, runQuery });

  const refused = async (source: string): Promise<{ codes: string[]; text: string }> => {
    const result = await pressed(source);
    if (result.ok) throw new Error("expected the gauntlet to refuse this screen");
    return { codes: result.issues.map(({ code }) => code), text: result.issues.map(({ message }) => message).join("\n") };
  };

  it("refuses a button whose handler does nothing, and calls it by the words on it", async () => {
    const { codes, text } = await refused(`import { Button, Stack, Text } from "@vendo/screen";

export default function BookVisit() {
  return (
    <Stack gap={12}>
      <Text text="Book a visit" variant="heading" />
      <Button label="Book appointment" onClick={() => {}} />
    </Stack>
  );
}
`);

    expect(codes).toEqual(["dead-control"]);
    expect(text).toContain(`pressing "Book appointment" calls nothing and changes nothing — wire it or remove it.`);
    expect(text).toContain("this one (Button onClick) asked for no tool and painted nothing new");
    expect(text).toContain("await tools.tool_name({ … })");
  });

  it("refuses a submit that falls out of a guard before it reaches anything", async () => {
    // The shape the run of record actually shipped: a "Book appointment" that
    // compiles, type-checks, paints, and returns before its own tool call.
    const { codes, text } = await refused(`import { useState } from "react";
import { Form, Input, Stack, tools } from "@vendo/screen";

export default function BookVisit() {
  const [id, setId] = useState("");

  const submit = async () => {
    if (!id) return;
    await tools.cancel_transfer({ id });
  };

  return (
    <Stack gap={12}>
      <Form onSubmit={submit} submitLabel="Book appointment">
        <Input label="Transfer" value={id} onChange={(e) => setId(e.target.value)} />
      </Form>
    </Stack>
  );
}
`);

    expect(codes).toEqual(["dead-control"]);
    expect(text).toContain(`pressing "Book appointment" calls nothing and changes nothing`);
    expect(text).toContain("this one (Form onSubmit) asked for no tool and painted nothing new");
    // The Input's onChange carries the value a person typed; a press has none,
    // so firing one would accuse a handler the press itself under-fed.
    expect(text).not.toContain("onChange");
  });

  it("passes a control that asks for a tool, even when the screen paints nothing new", async () => {
    const result = await pressed(`import { Button, Stack, tools } from "@vendo/screen";

export default function Cancel() {
  return (
    <Stack gap={12}>
      <Button label="Cancel it" variant="danger" onClick={() => { void tools.cancel_transfer({ id: "tr_1" }); }} />
    </Stack>
  );
}
`);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("passes a control that only opens a dialog, and presses nothing inside it", async () => {
    // Opening the dialog is the whole of what that button owes. Which control
    // inside it confirms is a judgement, not a lookup — so the dead "Yes" under
    // a shut Modal is not on the screen this check pressed.
    const result = await pressed(`import { useState } from "react";
import { Button, Modal, Stack } from "@vendo/screen";

export default function Confirm() {
  const [asking, setAsking] = useState(false);

  return (
    <Stack gap={12}>
      <Button label="Cancel transfer" onClick={() => setAsking(true)} />
      <Modal open={asking} onClose={() => setAsking(false)} title="Cancel this transfer?">
        <Button label="Yes, cancel it" variant="danger" onClick={() => {}} />
      </Modal>
    </Stack>
  );
}
`);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("OBSERVES the write a press asks for and never performs it", async () => {
    // `runQuery` is the only executor this check holds, and it is handed the
    // query plan and nothing else: a pressed `tools.cancel_transfer` records an
    // intent against a promise nobody settles, so the host's destructive tool is
    // never reached — by any venue, against any host.
    const ran: Ran[] = [];
    const result = await pressed(`import { Button, Stack, Text, tools, useQuery } from "@vendo/screen";

export default function Pending() {
  const pending = useQuery("list_pending_transfers");

  return (
    <Stack gap={12}>
      <Text text={"waiting: " + pending.data.length} />
      <Button label="Cancel the first" variant="danger" onClick={() => { void tools.cancel_transfer({ id: "tr_1" }); }} />
    </Stack>
  );
}
`, async (tool, input) => {
      ran.push({ tool, input });
      return ROWS;
    });

    expect(result.ok).toBe(true);
    expect(ran).toEqual([{ tool: "list_pending_transfers", input: undefined }]);
  });

  it("does not press a disabled control — being careful is not being dead", async () => {
    const result = await pressed(`import { Button, Stack, Text } from "@vendo/screen";

export default function Settings() {
  return (
    <Stack gap={12}>
      <Text text="Nothing has changed yet." variant="caption" />
      <Button label="Save changes" variant="primary" disabled onClick={() => {}} />
    </Stack>
  );
}
`);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("names the first few and counts the rest, so one repair does not fill the prompt", async () => {
    const { codes, text } = await refused(`import { Button, Stack } from "@vendo/screen";

const ACTIONS = ["one", "two", "three", "four", "five", "six", "seven", "eight"];

export default function Actions() {
  return (
    <Stack gap={12}>
      {ACTIONS.map((name) => <Button key={name} label={"Do " + name} onClick={() => {}} />)}
    </Stack>
  );
}
`);

    expect(codes).toEqual(Array.from({ length: 6 }, () => "dead-control"));
    expect(text).toContain(`pressing "Do one" calls nothing and changes nothing`);
    expect(text).toContain(`pressing "Do five" calls nothing and changes nothing`);
    expect(text).not.toContain(`pressing "Do six"`);
    expect(text).toContain("and 3 more control(s) on this screen do nothing when pressed");
  });
});

describe("screenCatalog", () => {
  it("is the whole Kit plus this host's own components, in that order", () => {
    const composed = screenCatalog([
      { name: "MapleNetWorthCard", propsJsonSchema: netWorthSchema },
      { name: "MapleTransferRow" },
    ]);

    expect(composed.slice(0, KIT_COMPONENT_NAMES.length)).toEqual([...KIT_COMPONENT_NAMES]);
    // A host entry brings its derived props schema along — the type check has no
    // other way to learn a host component's props — and a schema-less one travels
    // as the bare name it is.
    expect(composed.slice(-2)).toEqual([
      { name: "MapleNetWorthCard", propsJsonSchema: netWorthSchema },
      "MapleTransferRow",
    ]);
    // The whole Kit, not the wire-safe subset: a screen writes JSX, so the
    // element-valued slots the wire dialect could not express are ordinary here.
    expect(composed).toContain("Accordion");
  });
});

describe("screenName", () => {
  it("reads the component's own name, split on camel case", () => {
    expect(screenName(GOOD)).toBe("Pending transfers");
    expect(screenName("export default function Overview() {}")).toBe("Overview");
    expect(screenName("export default async function NetWorthOverTime() {}")).toBe("Net worth over time");
    expect(screenName("const Screen2 = () => null;\nexport default Screen2;")).toBe("Screen2");
  });

  it("never fails, and never blanks the app row", () => {
    // Read with a regex rather than off the AST because both callers ask BEFORE a
    // parse is guaranteed, and a title is never a reason to fail.
    expect(screenName("export default function () { return null; }")).toBe("Screen");
    expect(screenName("this file does not compile at all <<<")).toBe("Screen");
    expect(screenName("")).toBe("Screen");
  });
});

describe("reviewComponentScreenInput", () => {
  it("puts the TSX first and whole, then what the queries really returned", () => {
    const input = reviewComponentScreenInput({ source: GOOD, queryResults: { list_pending_transfers: ROWS } });

    expect(input.startsWith("SCREEN (the .tsx file this app renders):\n")).toBe(true);
    expect(input).toContain(GOOD);
    expect(input).toContain("RESOLVED_DATA (what this app's queries actually returned):");
    expect(input).toContain('list_pending_transfers: {"data":[{"id":"tr_1"');
  });

  it("truncates one long table so it cannot crowd the screen out of the prompt", () => {
    const long = { data: Array.from({ length: 2_000 }, (_, index) => ({ id: `tr_${index}`, note: "x".repeat(20) })) };
    const input = reviewComponentScreenInput({ source: GOOD, queryResults: { list_pending_transfers: long } });

    expect(input).toContain("…");
    expect(input).toContain(GOOD);
    expect(input.length).toBeLessThan(GOOD.length + 4_500);
  });

  it("says nothing about data when a screen has no queries", () => {
    expect(reviewComponentScreenInput({ source: GOOD, queryResults: {} })).toBe(
      `SCREEN (the .tsx file this app renders):\n${GOOD}`,
    );
  });
});

/**
 * FETCHED, AND NEVER SHOWN.
 *
 * The gap, from the 2026-08-17 runs: a tool returns rows carrying eight fields,
 * the screen paints three, and nothing in this pipeline ever computed the other
 * five — so a build list ships with no commit message and no author, a route
 * screen with no stop counts, and every check says the screen is fine. Both
 * sides were in the gauntlet's hands the whole time (the queries it executed, the
 * tree it painted) and nobody subtracted one from the other.
 */
describe("LEFTOVERS — what the queries returned and the screen never showed", () => {
  const tableCatalog = [...catalog, "DataTable"];

  const BUILDS_SCREEN = `import { DataTable, useQuery } from "@vendo/screen";

export default function Builds() {
  const builds = useQuery("list_accounts");
  return <DataTable rows={builds.data} columns={["build_number", "status", "branch"]} />;
}
`;

  /** Eight fields a build carries; the table above draws three of them. */
  const BUILDS = {
    data: [
      {
        id: "bld_412",
        build_number: 412,
        status: "passed",
        branch: "main",
        commit_message: "widen the reviewer's evidence",
        author: "ada",
        duration_ms: 91_000,
        queued_at: "2026-08-17T15:02:57Z",
      },
      {
        id: "bld_411",
        build_number: 411,
        status: "failed",
        branch: "main",
        commit_message: "press every control",
        author: "bob",
        duration_ms: 74_000,
        queued_at: "2026-08-17T14:41:02Z",
      },
    ],
  };

  /** A screen the gauntlet REALLY ran: the tree is the paint stage 4 took, never
   *  one a test wrote to make its own point. */
  const gauntlet = async (source: string, answer: unknown): Promise<ComponentScreenCheck> => {
    const result = await checkComponentScreen({
      source,
      hostTools: tools,
      catalog: tableCatalog,
      runQuery: async () => answer,
    });
    if (!result.ok) throw new Error(`the screen never painted: ${result.issues.map(({ message }) => message).join("\n")}`);
    return result;
  };

  const evidenceOf = (source: string, result: ComponentScreenCheck): string =>
    reviewComponentScreenInput({
      source,
      queryResults: result.queries ?? {},
      ...(result.initialTree === undefined ? {} : { painted: { tree: result.initialTree } }),
    });

  let builds: ComponentScreenCheck;
  let leftovers = "";

  beforeAll(async () => {
    builds = await gauntlet(BUILDS_SCREEN, BUILDS);
    const input = evidenceOf(BUILDS_SCREEN, builds);
    leftovers = input.slice(input.indexOf("LEFTOVERS ("));
  }, 60_000);

  it("names the fields a table fetched and never drew, with a sample of each", () => {
    expect(leftovers).toContain("LEFTOVERS (fields these queries returned that the screen never shows");
    // The two a person reading a build list came for, each with one real value
    // beside it — and the sample is what makes the field legible: "author" alone
    // could be an id.
    expect(leftovers).toContain(`data.commit_message ("widen the reviewer's evidence")`);
    expect(leftovers).toContain(`data.author ("ada")`);
    expect(leftovers).toContain("data.duration_ms (91000)");
    // THE POINT: those values were in the tree the whole time — a table is HANDED
    // its rows — and being handed is not being shown.
    expect(JSON.stringify(builds.initialTree)).toContain("widen the reviewer's evidence");
  });

  it("counts a column key as showing the field, because that is how a Kit table says so", () => {
    // The three the table draws are not leftovers, and their values never appear
    // as text anywhere in the paint — only their KEYS do.
    expect(leftovers).not.toContain("data.build_number");
    expect(leftovers).not.toContain("data.status");
    expect(leftovers).not.toContain("data.branch");
  });

  it("lists an id like every other leftover — which of them matter is the reviewer's call", () => {
    // The mechanism reports what was not shown and stops there. Nothing here
    // makes an id a finding and nothing here excuses it: the rubric hands that
    // judgment to the reviewer, which is the only reader that knows the ask.
    expect(leftovers).toContain(`data.id ("bld_412")`);
  });

  it("says nothing when the screen shows everything it fetched", async () => {
    const source = `import { Stack, Text, useQuery } from "@vendo/screen";

export default function Build() {
  const build = useQuery("list_accounts");
  return (
    <Stack gap={8}>
      <Text text={"Build " + build.build_number} variant="heading" />
      <Text text={build.author + " shipped it"} />
    </Stack>
  );
}
`;
    // The second one arrives inside a sentence rather than as the whole prop,
    // which is how a screen usually writes a name — and it still counts as shown.
    const input = evidenceOf(source, await gauntlet(source, { build_number: 412, author: "ada" }));

    expect(input).not.toContain("LEFTOVERS");
  }, 60_000);

  it("is absent — not empty — with no paint to subtract from and with nothing fetched", () => {
    const bare = `SCREEN (the .tsx file this app renders):\n${BUILDS_SCREEN}`;
    // No paint: nothing to compute leftovers against, and the prompt is byte for
    // byte the one it always was.
    expect(reviewComponentScreenInput({ source: BUILDS_SCREEN, queryResults: {} })).toBe(bare);
    // A paint and no queries: the same bytes again.
    expect(reviewComponentScreenInput({
      source: BUILDS_SCREEN,
      queryResults: {},
      ...(builds.initialTree === undefined ? {} : { painted: { tree: builds.initialTree } }),
    })).toBe(bare);
  });
});
