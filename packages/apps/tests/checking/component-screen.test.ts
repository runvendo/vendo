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
const catalog = ["Stack", "Row", "Card", "Text", "Money", "DateTime", "Button", "Callout"];

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
import { Button, Callout, Card, DateTime, Money, Row, Stack, Text, tools, useQuery } from "@vendo/screen";

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
              <Money amount={transfer.amount_cents / 100} />
              <DateTime value={transfer.scheduled_for} mode="date" />
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

  it("refuses a query that WRITES, because a query runs on every render", async () => {
    const { codes, text } = await refusal(`import { Text, useQuery } from "@vendo/screen";
export default function S() { return <Text text={String(useQuery("cancel_transfer"))} />; }
`);

    expect(codes).toEqual(["query-tool"]);
    expect(text).toContain('reads with a tool that CHANGES things (risk "destructive")');
    expect(text).toContain("this would write every time the screen paints");
    expect(text).toContain("Call it from a handler as tools.cancel_transfer({ … })");
  });

  it("refuses a computed query input, and says where the derivation belongs", async () => {
    const { codes, text } = await refusal(`import { useState } from "react";
import { Text, useQuery } from "@vendo/screen";
export default function S() {
  const [status] = useState("pending");
  const rows = useQuery("list_pending_transfers", { status });
  return <Text text={String(rows.data.length)} />;
}
`);

    expect(codes).toEqual(["query-input"]);
    expect(text).toContain("passes a computed input to useQuery");
    expect(text).toContain("must be LITERAL JSON the tool can execute directly");
    expect(text).toContain("derive what you needed from the result where you DISPLAY it");
  });

  it("refuses an input that only LOOKS literal", async () => {
    // A spread and a computed key are both computed: the queries run before the
    // component renders, so whatever they would read does not exist yet.
    for (const input of ['{ ...defaults }', '{ [field]: "pending" }', '{ tags: ["a", , "b"] }']) {
      const { codes, text } = await refusal(`import { Stack, Text, useQuery } from "@vendo/screen";
const defaults = { status: "pending" };
const field = "status";
export default function S() {
  const found = useQuery("search_transfers", ${input});
  return <Stack><Text text={String(found.data.length)} /></Stack>;
}
`);
      expect(codes).toEqual(["query-input"]);
      expect(text).toContain("passes a computed input to useQuery");
    }
  });

  it("refuses the same tool read with two DIFFERENT inputs", async () => {
    const { codes, text } = await refusal(`import { Stack, Text, useQuery } from "@vendo/screen";
export default function S() {
  const pending = useQuery("list_pending_transfers", { status: "pending" });
  const sent = useQuery("list_pending_transfers", { status: "sent" });
  return <Stack><Text text={String(pending.data.length)} /><Text text={String(sent.data.length)} /></Stack>;
}
`);

    expect(codes).toEqual(["query-input"]);
    expect(text).toContain('reads "list_pending_transfers" twice with DIFFERENT inputs');
    expect(text).toContain("a screen resolves one result per tool");
  });

  it("refuses more arguments than useQuery takes", async () => {
    const { text } = await refusal(`import { Text, useQuery } from "@vendo/screen";
export default function S() {
  const rows = useQuery("list_pending_transfers", { status: "pending" }, true);
  return <Text text={String(rows)} />;
}
`);

    expect(text).toContain("with 3 arguments — it takes the tool name and, at most, one literal input object");
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
    expect(text).toContain("Anything with behavior comes from \"@vendo/screen\": Stack, Row, Card, Text, Money, DateTime, Button, Callout.");
    // The closing tag is the same break; a repair list that says everything
    // twice reads as two problems.
    expect(text.match(/writes the HTML element/gu)).toHaveLength(1);
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
    expect(text).toContain("The components available are: Stack, Row, Card, Text, Money, DateTime, Button, Callout.");
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
  const kitCatalog = [...catalog, "Badge", "DataTable", "EnumBadge", "LineChart", "Sparkline", "Stat"];

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

  it("refuses a control in a cell slot, and names what a cell may hold", async () => {
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

    expect(result.ok).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(["nesting"]);
    const message = result.issues[0]?.message ?? "";
    // The locus is the column the control sits in, not just the table.
    expect(message).toContain('prop "columns[0].cell" holds <Button> in a cell slot');
    expect(message).toContain("a cell is read, never operated");
    expect(message).toContain("A cell may hold: Text, Money, DateTime, Percent, Num, EnumBadge, Badge, Sparkline, Progress, Stack, Row");
  });

  it("follows a control nested INSIDE a legal slot component", async () => {
    const result = await painted(`import { Button, DataTable, Stack, Text, tools } from "@vendo/screen";

export default function Ledger() {
  return (
    <DataTable
      rows={[{ id: "tr_1", status: "paid" }]}
      columns={[{ key: "status", cell: <Stack><Text field="status" /><Button label="Cancel" onClick={() => tools.cancel_transfer({ id: "tr_1" })} /></Stack> }]}
    />
  );
}
`);

    expect(result.issues.map(({ code }) => code)).toEqual(["nesting"]);
    expect(result.issues[0]?.message).toContain('prop "columns[0].cell.children[1]" holds <Button> in a cell slot');
  });

  /** A slot's vocabulary gates BEHAVIOR — what may sort, submit or call a tool
   *  where there is no row to act on. A display brick has none to gate: it is
   *  `style` and children and nothing else, so it passes the same per-row cell
   *  that refuses a Button, and the renderer builds it back
   *  (`packages/ui` renderer.tsx `reifyElement`). Whole gauntlet, real compiler. */
  it("passes a display brick in a per-row cell — arrangement is not behavior", async () => {
    const result = await painted(`import { DataTable, Text } from "@vendo/screen";

export default function Invoices() {
  return (
    <DataTable
      rows={[{ id: "r1", status: "past_due" }]}
      columns={[{ key: "status", cell: <div style={{ display: "flex" }}><Text field="status" /></div> }]}
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
        columns={[{ key: "status", cell: <EnumBadge field="status" /> }]}
      />
    </Stack>
  );
}
`);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
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
