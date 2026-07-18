import { describe, expect, it } from "vitest";
import { validateTreeV2 } from "../tree-v2.js";
import { compileWireV2, type WireCompileOptions } from "./compile.js";
import { compileWirePatchV2, type WirePatchResult } from "./patch.js";

/** v2 spec §5 — one dialect: edits are `<Edit>` documents of op elements in
 *  the same grammar, applied against compiler-stamped ids, deterministic and
 *  total, re-validated (validateTreeV2 + the wave-3 shape check). */

const OPTIONS: WireCompileOptions = { hostComponents: ["HostCard"] };

const BASE_WIRE = `<App name="Cash">
  <Query id="revenue" tool="metrics_revenue"/>
  <Stack gap={16}>
    <PageHeader title="Cash"/>
    <Grid cols={2}>
      <LineChart title="Revenue" points={revenue.rows | asPoints(month, revenue)}/>
      <DataTable rows={revenue.rows}/>
    </Grid>
    <Button label="Remind" onClick="fn:send_reminder"/>
  </Stack>
</App>`;

const base = () => compileWireV2(BASE_WIRE, OPTIONS);

const patch = (edit: string, baseResult = base(), options = OPTIONS): WirePatchResult => {
  const result = compileWirePatchV2(edit, baseResult, options);
  const validation = validateTreeV2(result.tree);
  expect(validation.ok).toBe(true);
  return result;
};

const codes = (result: WirePatchResult): string[] => result.issues.map((issue) => issue.code);
const node = (result: WirePatchResult, id: string) => result.tree.nodes.find((entry) => entry.id === id);

describe("compileWirePatchV2 Set/Unset", () => {
  it("Set merges attributes into the target's props (expressions, actions, bindings included)", () => {
    const result = patch(`<Edit>
      <Set id="linechart-1" title="Revenue (12mo)" smooth points={revenue.rows | asPoints(month, revenue)}/>
      <Set id="button-1" onClick="fn:send_digest"/>
    </Edit>`);
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
    expect(node(result, "linechart-1")?.props).toStrictEqual({
      title: "Revenue (12mo)",
      points: { $path: "/revenue/rows", $reshape: [{ op: "asPoints", args: ["month", "revenue"] }] },
      smooth: true,
    });
    expect(node(result, "button-1")?.props).toStrictEqual({ label: "Remind", onClick: { action: "fn:send_digest" } });
  });

  it("Unset removes the named props", () => {
    const result = patch('<Edit><Unset id="pageheader-1" title/></Edit>');
    expect(result.issues).toEqual([]);
    expect(node(result, "pageheader-1")?.props).toBeUndefined();
  });

  it("edit locality: untouched nodes keep their exact object identity", () => {
    const before = base();
    const result = patch('<Edit><Set id="pageheader-1" title="New"/></Edit>', before);
    const untouchedBefore = before.tree.nodes.find((entry) => entry.id === "datatable-1");
    expect(node(result, "datatable-1")).toBe(untouchedBefore);
    expect(before.tree.nodes.find((entry) => entry.id === "pageheader-1")?.props)
      .toStrictEqual({ title: "Cash" }); // the base is never mutated
  });
});

describe("compileWirePatchV2 Insert/Remove/Move", () => {
  it("Insert compiles a subtree at the index, minting fresh ids past the base ordinals", () => {
    const result = patch(`<Edit>
      <Insert into="grid-1" at={1}><Stat label="Total" value={revenue.rows | sum(revenue)}/></Insert>
    </Edit>`);
    expect(result.issues).toEqual([]);
    expect(node(result, "grid-1")?.children).toEqual(["linechart-1", "stat-1", "datatable-1"]);
    expect(node(result, "stat-1")?.source).toBe("prewired");
  });

  it("Insert without at appends; inserted LineChart continues the ordinal (linechart-2)", () => {
    const result = patch('<Edit><Insert into="grid-1"><LineChart title="Costs"/></Insert></Edit>');
    expect(node(result, "grid-1")?.children).toEqual(["linechart-1", "datatable-1", "linechart-2"]);
  });

  it("Remove deletes the node and its whole subtree", () => {
    const result = patch('<Edit><Remove id="grid-1"/></Edit>');
    expect(result.issues).toEqual([]);
    expect(node(result, "grid-1")).toBeUndefined();
    expect(node(result, "linechart-1")).toBeUndefined();
    expect(node(result, "datatable-1")).toBeUndefined();
    expect(node(result, "stack-1")?.children).toEqual(["pageheader-1", "button-1"]);
  });

  it("Move reparents and reorders", () => {
    const result = patch('<Edit><Move id="button-1" into="grid-1" at={0}/></Edit>');
    expect(result.issues).toEqual([]);
    expect(node(result, "grid-1")?.children).toEqual(["button-1", "linechart-1", "datatable-1"]);
    expect(node(result, "stack-1")?.children).toEqual(["pageheader-1", "grid-1"]);
  });

  it("guards: unknown targets, root removal, and cycle moves are skipped with issues", () => {
    const result = patch(`<Edit>
      <Set id="ghost-9" title="x"/>
      <Remove id="root"/>
      <Move id="stack-1" into="grid-1" at={0}/>
      <Insert into="ghost-9"><Card/></Insert>
    </Edit>`);
    expect(codes(result)).toEqual(["unknown-target", "invalid-patch-op", "invalid-patch-op", "unknown-target"]);
    // Nothing applied: the tree is structurally the base.
    expect(result.tree.nodes.map((entry) => entry.id)).toEqual(base().tree.nodes.map((entry) => entry.id));
  });
});

describe("compileWirePatchV2 queries, islands, name", () => {
  it("Query upserts (new appends, same name replaces) and RemoveQuery deletes", () => {
    const result = patch(`<Edit>
      <Query id="payments" tool="payments_list" input={{ limit: 5 }}/>
      <Query id="revenue" tool="metrics_revenue_v2"/>
    </Edit>`);
    expect(result.issues).toEqual([]);
    expect(result.tree.queries).toEqual([
      { name: "revenue", tool: "metrics_revenue_v2" },
      { name: "payments", tool: "payments_list", input: { limit: 5 } },
    ]);
    const removed = patch('<Edit><RemoveQuery id="revenue"/></Edit>');
    expect(removed.tree.queries).toBeUndefined();
  });

  it("a Set binding may reference a Query declared later in the same patch", () => {
    const result = patch(`<Edit>
      <Set id="datatable-1" rows={payments.items}/>
      <Query id="payments" tool="payments_list"/>
    </Edit>`);
    expect(result.issues).toEqual([]);
    expect(node(result, "datatable-1")?.props?.rows).toEqual({ $path: "/payments/items" });
  });

  it("Island upserts and an inserted node resolves generated against it; RemoveIsland degrades sources", () => {
    const result = patch(`<Edit>
      <Island name="Sparkline">export default function Sparkline() { return null; }</Island>
      <Insert into="grid-1"><Sparkline/></Insert>
    </Edit>`);
    expect(result.issues).toEqual([]);
    expect(result.components.Sparkline).toContain("Sparkline");
    expect(node(result, "sparkline-1")?.source).toBe("generated");
    const removed = patch('<Edit><RemoveIsland name="Sparkline"/></Edit>', result);
    expect(removed.components).toStrictEqual({});
    expect(node(removed, "sparkline-1")?.source).toBeUndefined();
  });

  it("SetName renames the app", () => {
    expect(patch('<Edit><SetName name="Cash HQ"/></Edit>').name).toBe("Cash HQ");
    expect(patch("<Edit><Card/></Edit>").name).toBe("Cash");
  });
});

describe("compileWirePatchV2 totality and re-validation", () => {
  it("a non-Edit document changes nothing (missing-edit)", () => {
    const before = base();
    const result = compileWirePatchV2('<App name="nope"/>', before, OPTIONS);
    expect(codes(result)).toEqual(["missing-edit"]);
    expect(result.tree).toStrictEqual(before.tree);
    expect(result.complete).toBe(false);
  });

  it("a truncated patch applies the parsed ops and reports incomplete", () => {
    const result = compileWirePatchV2('<Edit><Set id="pageheader-1" title="New"/><Set id="line', base(), OPTIONS);
    expect(node(result, "pageheader-1")?.props?.title).toBe("New");
    expect(result.complete).toBe(false);
    expect(codes(result)).toContain("truncated-tag");
  });

  it("unknown op elements and trailing content are contained", () => {
    const result = patch('<Edit><Teleport id="x"/><Set id="pageheader-1" title="New"/></Edit> junk');
    expect(node(result, "pageheader-1")?.props?.title).toBe("New");
    expect(codes(result)).toEqual(["invalid-patch-op", "trailing-content"]);
    expect(result.complete).toBe(false);
  });

  it("re-runs the wave-3 shape check on the final tree", () => {
    const toolShapes: WireCompileOptions = {
      ...OPTIONS,
      toolShapes: {
        metrics_revenue: {
          kind: "object",
          fields: {
            rows: {
              kind: "array",
              items: { kind: "object", fields: { month: { kind: "string" }, revenue: { kind: "number" } } },
            },
          },
        },
      },
    };
    const result = compileWirePatchV2(
      '<Edit><Set id="linechart-1" points={revenue.rows | asPoints(period, amount)}/></Edit>',
      compileWireV2(BASE_WIRE, toolShapes),
      toolShapes,
    );
    expect(codes(result)).toEqual(["shape-mismatch"]);
    expect(result.bindingErrors[0]).toMatchObject({
      nodeId: "linechart-1",
      prop: "points",
      missing: ["period", "amount"],
    });
  });

  it("is deterministic: identical patch on identical base twice is deep-equal", () => {
    const edit = '<Edit><Set id="pageheader-1" title="New"/><Insert into="grid-1"><Card/></Insert></Edit>';
    const first = patch(edit);
    const second = patch(edit);
    expect(second).toStrictEqual(first);
  });
});

describe("compileWirePatchV2 unknown paired ops", () => {
  it("skips a paired unknown op's whole subtree exactly once (no cursor drift)", () => {
    const result = patch('<Edit><Teleport id="x"><Card/><Set id="pageheader-1" title="inside"/></Teleport><Set id="pageheader-1" title="after"/></Edit>');
    expect(codes(result)).toEqual(["invalid-patch-op"]);
    expect(node(result, "pageheader-1")?.props?.title).toBe("after");
    expect(node(result, "card-1")).toBeUndefined();
  });
});

describe("compileWirePatchV2 extension ops", () => {
  it("collects declared extension ops (parsed attrs, document order) without issues or application", () => {
    const result = patch(
      '<Edit><ForkPin slot="cards/Revenue" props={{ tone: "bold" }}/><Set id="pageheader-1" title="New"/><SetDescription text="d"/></Edit>',
      base(),
      { ...OPTIONS, extensionOps: ["ForkPin", "SetDescription"] },
    );
    expect(result.issues).toEqual([]);
    expect(result.extensionOps).toEqual([
      { op: "ForkPin", props: { slot: "cards/Revenue", props: { tone: "bold" } } },
      { op: "SetDescription", props: { text: "d" } },
    ]);
    expect(node(result, "pageheader-1")?.props?.title).toBe("New");
  });

  it("undeclared ops still fail as invalid-patch-op; declared paired ops skip their content", () => {
    const undeclared = patch('<Edit><ForkPin slot="s"/></Edit>');
    expect(codes(undeclared)).toEqual(["invalid-patch-op"]);
    expect(undeclared.extensionOps).toEqual([]);
    const paired = patch(
      '<Edit><ForkPin slot="s"><Card/></ForkPin></Edit>',
      base(),
      { ...OPTIONS, extensionOps: ["ForkPin"] },
    );
    expect(codes(paired)).toEqual(["invalid-patch-op"]);
    expect(paired.extensionOps).toEqual([{ op: "ForkPin", props: { slot: "s" } }]);
    expect(node(paired, "card-1")).toBeUndefined();
  });
});

describe("compileWirePatchV2 strict op attributes", () => {
  it("rejects unknown attributes on structural ops instead of silently misplacing (position alias)", () => {
    const result = patch('<Edit><Insert into="grid-1" position={0}><Card/></Insert></Edit>');
    expect(codes(result)).toEqual(["invalid-patch-op"]);
    expect(result.issues[0]?.message).toContain('"position"');
    expect(node(result, "card-1")).toBeUndefined();
    expect(codes(patch('<Edit><Move id="button-1" into="grid-1" order={0}/></Edit>'))).toEqual(["invalid-patch-op"]);
    expect(codes(patch('<Edit><Remove id="button-1" force/></Edit>'))).toEqual(["invalid-patch-op"]);
  });

  it("rejects an index that leaves a gap instead of silently appending", () => {
    const result = patch('<Edit><Move id="button-1" into="grid-1" at={4}/></Edit>');
    expect(codes(result)).toEqual(["invalid-patch-op"]);
    expect(result.issues[0]?.message).toContain("gap");
    expect(node(result, "grid-1")?.children).toEqual(["linechart-1", "datatable-1"]);
    expect(codes(patch('<Edit><Insert into="grid-1" at={3}><Card/></Insert></Edit>'))).toEqual(["invalid-patch-op"]);
  });

  it("names the descendant rule in the cycle message", () => {
    const result = patch('<Edit><Move id="stack-1" into="grid-1"/></Edit>');
    expect(result.issues[0]?.message).toContain("descendant");
  });
});

describe("compileWirePatchV2 appliedOps", () => {
  it("counts applied ops — a structurally no-op Move still counts; skipped ops do not", () => {
    expect(patch('<Edit><Move id="datatable-1" into="grid-1" at={1}/></Edit>').appliedOps).toBe(1);
    expect(patch('<Edit><Set id="ghost-9" title="x"/></Edit>').appliedOps).toBe(0);
    expect(patch('<Edit><Query id="p" tool="t"/><Set id="pageheader-1" a="1"/></Edit>').appliedOps).toBe(2);
  });
});
