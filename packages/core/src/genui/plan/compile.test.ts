import { describe, expect, it } from "vitest";
import { compilePlan, type PlanFacts } from "./compile.js";
import { planTabs } from "./types.js";

const FACTS: PlanFacts = {
  tools: ["host_listInvoices", "host_listClients", "host_sendMessage"],
  components: ["StatTile", "BarChart", "DataTable", "PageHeader"],
};

/** The shape of a plan the brain writes for a normal ask, wrapped in the
 *  prose and fence models add despite instructions. */
const FULL_EXAMPLE = `Here is the plan.

\`\`\`xml
<Plan name="Invoices workspace">
  <Query id="invoices" tool="host_listInvoices" input={{ limit: 50 }}/>
  <Query id="clients" tool="host_listClients"/>
  <Group tab="Overview" title="Health" layout="grid">
    <Leaf component="StatTile" query="invoices" purpose="Total outstanding across every open invoice" col="1"/>
    <Leaf component="BarChart" query="invoices" purpose="Invoiced amount per month over the last year" col="2" span="2"/>
  </Group>
  <Group tab="Overview">
    <Leaf component="DataTable" query="clients" purpose="Clients with the most outstanding, worst first"/>
  </Group>
  <Group tab="Payments" title="Payment history" waitsForServer>
    <Leaf component="DataTable" query="invoices" purpose="Every payment recorded against an invoice"/>
  </Group>
  <Island name="RunwayDial" purpose="A cash dial no chart component can express"/>
  <Server kind="steps" schedule="fridays" why="Chasing overdue invoices has to happen when nobody has the app open."/>
  <Cannot>Your host has no way to send email, so reminders land in the app's own log instead.</Cannot>
  <Cannot>Nothing here can write an invoice off — that tool is read-only.</Cannot>
</Plan>
\`\`\`
`;

describe("compilePlan", () => {
  it("parses the full example to the locked flat plan", () => {
    const result = compilePlan(FULL_EXAMPLE, FACTS);
    expect(result.issues).toEqual([]);
    expect(result.plan).toStrictEqual({
      name: "Invoices workspace",
      queries: [
        { id: "invoices", tool: "host_listInvoices", input: { limit: 50 } },
        { id: "clients", tool: "host_listClients", input: {} },
      ],
      groups: [
        {
          tab: "Overview",
          title: "Health",
          layout: "grid",
          leaves: [
            {
              component: "StatTile",
              query: "invoices",
              purpose: "Total outstanding across every open invoice",
              attrs: { col: "1" },
            },
            {
              component: "BarChart",
              query: "invoices",
              purpose: "Invoiced amount per month over the last year",
              attrs: { col: "2", span: "2" },
            },
          ],
        },
        {
          tab: "Overview",
          leaves: [
            { component: "DataTable", query: "clients", purpose: "Clients with the most outstanding, worst first" },
          ],
        },
        {
          tab: "Payments",
          title: "Payment history",
          waitsForServer: true,
          leaves: [
            { component: "DataTable", query: "invoices", purpose: "Every payment recorded against an invoice" },
          ],
        },
      ],
      island: { name: "RunwayDial", purpose: "A cash dial no chart component can express" },
      server: {
        kind: "steps",
        schedule: "fridays",
        why: "Chasing overdue invoices has to happen when nobody has the app open.",
      },
      cannot: [
        "Your host has no way to send email, so reminders land in the app's own log instead.",
        "Nothing here can write an invoice off — that tool is read-only.",
      ],
    });
  });

  it("derives two tabs from the group labels, in order of first appearance", () => {
    const plan = compilePlan(FULL_EXAMPLE, FACTS).plan;
    expect(plan === undefined ? [] : planTabs(plan)).toEqual(["Overview", "Payments"]);
  });

  it("parses groups without tab labels as one surface", () => {
    const result = compilePlan(
      `<Plan name="Client list">
         <Query id="clients" tool="host_listClients"/>
         <Group title="Everyone">
           <Leaf component="DataTable" query="clients" purpose="Every client with their outstanding balance"/>
         </Group>
       </Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([]);
    expect(result.plan?.groups).toStrictEqual([
      {
        title: "Everyone",
        leaves: [
          { component: "DataTable", query: "clients", purpose: "Every client with their outstanding balance" },
        ],
      },
    ]);
    expect(planTabs(result.plan as NonNullable<typeof result.plan>)).toEqual([]);
  });

  it("drops the sixth leaf in a group and says to split the group", () => {
    const leaves = Array.from(
      { length: 6 },
      (_unused, index) => `<Leaf component="StatTile" purpose="Headline number ${index + 1}"/>`,
    ).join("");
    const result = compilePlan(`<Plan name="Six"><Group title="Health">${leaves}</Group></Plan>`, FACTS);
    expect(result.plan?.groups[0]?.leaves).toHaveLength(5);
    expect(result.issues).toEqual([
      'the group "Health" holds 6 parts, and one group holds at most 5 — one worker writes a whole group, so split this into two groups (they can share a tab label). The last part was dropped.',
    ]);
  });

  it("cannot write a group inside a group", () => {
    const result = compilePlan(
      `<Plan name="Nested">
         <Group tab="Overview">
           <Leaf component="StatTile" purpose="Total outstanding right now"/>
           <Group tab="Overview" title="Inner">
             <Leaf component="BarChart" purpose="Invoiced amount per month"/>
           </Group>
         </Group>
       </Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([
      "a group cannot sit inside a group: a plan is two levels deep — groups hold leaves, and tabs come from each group's tab label. The nested group and everything in it was dropped.",
    ]);
    expect(result.plan?.groups).toStrictEqual([
      { tab: "Overview", leaves: [{ component: "StatTile", purpose: "Total outstanding right now" }] },
    ]);
  });

  it("names an unknown tool and lists the host's real ones", () => {
    const result = compilePlan(
      `<Plan name="Bad tool"><Query id="invoices" tool="stripe_invoices_list"/>
         <Group><Leaf component="DataTable" query="invoices" purpose="Every invoice"/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([
      'there is no tool called "stripe_invoices_list". This host\'s tools are: host_listInvoices, host_listClients, host_sendMessage. Point query "invoices" at one of those, or say what you cannot do in a <Cannot> line.',
    ]);
  });

  it("names an unknown component and lists the real ones", () => {
    const result = compilePlan(
      `<Plan name="Bad component"><Group><Leaf component="InvoiceGrid" purpose="Every invoice in a grid"/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([
      'there is no component called "InvoiceGrid". The components you can use are: StatTile, BarChart, DataTable, PageHeader. Pick the closest fit, or declare an <Island> when none of them can express it.',
    ]);
  });

  it("reports a schedule no scheduler can read", () => {
    const result = compilePlan(
      `<Plan name="Bad schedule"><Group><Leaf component="StatTile" purpose="Total outstanding"/></Group>
         <Server kind="steps" schedule="0 99 * * *" why="Nobody has the app open on a Friday night."/></Plan>`,
      FACTS,
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain('no scheduler can read the schedule "0 99 * * *"');
    expect(result.issues[0]).toContain('say the cadence in words ("every Friday morning")');
    expect(result.plan?.server?.schedule).toBe("0 99 * * *");
  });

  it("reports a cron with the wrong number of fields", () => {
    const result = compilePlan(
      `<Plan name="Short cron"><Group><Leaf component="StatTile" purpose="Total outstanding"/></Group>
         <Server kind="steps" schedule="0 9 * *" why="Nobody has the app open in the morning."/></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([
      'the schedule "0 9 * *" reads as a cron but has 4 fields instead of 5. Write a 5-field cron ("0 9 * * 5"), or just say the cadence in words ("every Friday morning").',
    ]);
  });

  it("reports a leaf reading a query the plan never declared", () => {
    const result = compilePlan(
      `<Plan name="Dangling"><Query id="invoices" tool="host_listInvoices"/>
         <Group><Leaf component="DataTable" query="overdue" purpose="Overdue invoices, worst first"/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([
      'the DataTable leaf reads a query called "overdue", but this plan declares no <Query id="overdue">. Declare it at the top of the plan, or drop the query attribute.',
    ]);
    expect(result.plan?.groups[0]?.leaves[0]?.query).toBe("overdue");
  });

  it("reports missing structure instead of throwing", () => {
    expect(compilePlan("I built the app already.", FACTS)).toStrictEqual({
      issues: ['I could not find a plan here: a plan is one <Plan name="...">...</Plan> document and nothing else.'],
    });
    const truncated = compilePlan('<Plan name="Cut off"><Group tab="Overview"><Leaf component="StatTile"', FACTS);
    expect(truncated.plan?.name).toBe("Cut off");
    expect(truncated.issues.join(" ")).toContain("ended before </Plan>");
  });

  it("caps the issue list, because the issues become the retry prompt", () => {
    // One stray close tag mints one sentence, so a hostile (or merely broken)
    // document otherwise hands the model an issue per byte.
    const result = compilePlan(`<Plan name="Noise">${"</X>".repeat(2000)}</Plan>`, FACTS);
    expect(result.issues.length).toBeLessThan(200);
    expect(result.issues.at(-1)).toContain("were not listed");
  });

  it("counts a single omitted issue in the singular", () => {
    // The issue list is the retry prompt verbatim, so "1 further problems" is
    // a grammatical error handed straight to the model.
    const result = compilePlan(`<Plan name="Noise">${"</X>".repeat(64)}</Plan>`, FACTS);
    expect(result.issues).toHaveLength(65);
    expect(result.issues.at(-1)).toBe("1 further problem was not listed — fix these first and write the plan again.");
  });

  it("reads a valid five-field cron schedule without complaint", () => {
    const result = compilePlan(
      `<Plan name="Valid cron"><Group><Leaf component="StatTile" purpose="Total outstanding"/></Group>
         <Server kind="steps" schedule="0 9 * * 5" why="Nobody has the app open on a Friday morning."/></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([]);
    expect(result.plan?.server?.schedule).toBe("0 9 * * 5");
  });

  it("ignores a <Query> written with content instead of self-closing", () => {
    const result = compilePlan(
      `<Plan name="Query with content"><Query id="invoices" tool="host_listInvoices">oops</Query>
         <Group><Leaf component="DataTable" query="invoices" purpose="Every invoice"/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toContain(
      "<Query> holds nothing — write it as one self-closing element; its content was ignored.",
    );
    expect(result.plan?.queries).toStrictEqual([{ id: "invoices", tool: "host_listInvoices", input: {} }]);
  });

  it("drops a query with no id, naming the required shape", () => {
    const result = compilePlan(
      `<Plan name="No id"><Query tool="host_listInvoices"/><Group><Leaf component="StatTile" purpose="Total"/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([
      'a <Query> needs an id that is a plain identifier (and never "state") — <Query id="invoices" tool="..."/> — so leaves can point at it. This query was dropped.',
    ]);
    expect(result.plan?.queries).toEqual([]);
  });

  it("refuses \"state\" as a query id", () => {
    const result = compilePlan(
      `<Plan name="Reserved id"><Query id="state" tool="host_listInvoices"/><Group><Leaf component="StatTile" purpose="Total"/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues[0]).toContain('needs an id that is a plain identifier (and never "state")');
  });

  it("drops the second query sharing an id", () => {
    const result = compilePlan(
      `<Plan name="Dup query"><Query id="invoices" tool="host_listInvoices"/><Query id="invoices" tool="host_listClients"/>
         <Group><Leaf component="DataTable" query="invoices" purpose="Every invoice"/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toContain(
      'two queries are called "invoices" — give each one its own id. The second was dropped.',
    );
    expect(result.plan?.queries).toStrictEqual([{ id: "invoices", tool: "host_listInvoices", input: {} }]);
  });

  it("drops a query with no tool attribute", () => {
    const result = compilePlan(
      `<Plan name="No tool"><Query id="invoices"/><Group><Leaf component="StatTile" purpose="Total"/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toContain(
      'query "invoices" needs a tool attribute naming the host tool it reads. The query was dropped.',
    );
    expect(result.plan?.queries).toEqual([]);
  });

  it("drops a query's input when it is not an object", () => {
    const result = compilePlan(
      `<Plan name="Bad input"><Query id="invoices" tool="host_listInvoices" input="everything"/>
         <Group><Leaf component="DataTable" query="invoices" purpose="Every invoice"/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toContain(
      'query "invoices" input must be an object — input={{ limit: 20 }}. The input was dropped.',
    );
    expect(result.plan?.queries[0]).toStrictEqual({ id: "invoices", tool: "host_listInvoices", input: {} });
  });

  it("ignores a <Leaf> written with content instead of self-closing", () => {
    const result = compilePlan(
      `<Plan name="Leaf with content"><Group><Leaf component="StatTile" purpose="Total outstanding">oops</Leaf></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toContain(
      "<Leaf> holds nothing — write it as one self-closing element; its content was ignored.",
    );
    expect(result.plan?.groups[0]?.leaves).toStrictEqual([{ component: "StatTile", purpose: "Total outstanding" }]);
  });

  it("drops a leaf's arrangement hint when its value is a list, not a primitive", () => {
    const result = compilePlan(
      `<Plan name="List hint"><Group><Leaf component="StatTile" purpose="Total outstanding" tags={[1,2]}/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([
      'the StatTile leaf\'s "tags" is an arrangement hint like col="2", and a list cannot be one. It was dropped.',
    ]);
    expect(result.plan?.groups[0]?.leaves[0]?.attrs).toBeUndefined();
  });

  it("drops a leaf's arrangement hint when its value is null, not a primitive", () => {
    const result = compilePlan(
      `<Plan name="Null hint"><Group><Leaf component="StatTile" purpose="Total outstanding" tags={null}/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([
      'the StatTile leaf\'s "tags" is an arrangement hint like col="2", and null cannot be one. It was dropped.',
    ]);
    expect(result.plan?.groups[0]?.leaves[0]?.attrs).toBeUndefined();
  });

  it("reports loose text sitting inside a group", () => {
    const result = compilePlan(
      `<Plan name="Loose text"><Group tab="Overview">
           stray words that do not belong here
           <Leaf component="StatTile" purpose="Total outstanding"/>
         </Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([
      '"stray words that do not belong here" sits loose inside the group "Overview", which holds <Leaf> elements only; it was ignored.',
    ]);
  });

  it("closes an unclosed group for you and says so", () => {
    const result = compilePlan(
      `<Plan name="Unclosed group"><Group tab="Overview"><Leaf component="StatTile" purpose="Total outstanding"/></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([
      'the group "Overview" was never closed — its </Group> is missing. It was closed for you.',
    ]);
    expect(result.plan?.groups[0]?.leaves).toStrictEqual([{ component: "StatTile", purpose: "Total outstanding" }]);
  });

  it("keeps reading the group after a stray close tag that opens nothing", () => {
    const result = compilePlan(
      `<Plan name="Stray close"><Group tab="Overview">
           <Leaf component="StatTile" purpose="Total outstanding"/></Leaf>
           <Leaf component="DataTable" purpose="Every invoice"/>
         </Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual(["</Leaf> closes nothing that is open here; it was ignored."]);
    expect(result.plan?.groups[0]?.leaves).toStrictEqual([
      { component: "StatTile", purpose: "Total outstanding" },
      { component: "DataTable", purpose: "Every invoice" },
    ]);
  });

  it("stops cleanly on a lone trailing '<' inside a group", () => {
    const result = compilePlan(
      `<Plan name="Trailing"><Group tab="Overview"><Leaf component="StatTile" purpose="Total outstanding"/><`,
      FACTS,
    );
    expect(result.plan?.groups[0]?.leaves).toStrictEqual([{ component: "StatTile", purpose: "Total outstanding" }]);
    expect(result.issues).toEqual([
      "the plan ended before </Plan>, so it was read only as far as it got. Write it again whole.",
    ]);
  });

  it("drops an unrecognized tag inside a group", () => {
    const result = compilePlan(
      `<Plan name="Odd tag inside group"><Group tab="Overview"><Foo/><Leaf component="StatTile" purpose="Total outstanding"/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([
      "<Foo> means nothing inside a group, which holds <Leaf> elements only. It was dropped.",
    ]);
    expect(result.plan?.groups[0]?.leaves).toStrictEqual([{ component: "StatTile", purpose: "Total outstanding" }]);
  });

  it("teaches the bare-flag form when waitsForServer carries a value", () => {
    const result = compilePlan(
      `<Plan name="Waits value"><Group tab="Overview" waitsForServer="yes"><Leaf component="StatTile" purpose="Total outstanding"/></Group></Plan>`,
      FACTS,
    );
    expect(result.plan?.groups[0]?.waitsForServer).toBeUndefined();
    expect(result.issues).toContain(
      "waitsForServer is a bare flag — write <Group waitsForServer> when a group fills only after the server reports its interface. It was ignored.",
    );
  });

  it("ignores a <Server> written with content instead of self-closing", () => {
    const result = compilePlan(
      `<Plan name="Server with content"><Group><Leaf component="StatTile" purpose="Total"/></Group>
         <Server kind="steps" why="Nobody has the app open at night.">oops</Server></Plan>`,
      FACTS,
    );
    expect(result.issues).toContain(
      "<Server> holds nothing — write it as one self-closing element; its content was ignored.",
    );
    expect(result.plan?.server?.kind).toBe("steps");
  });

  it("drops a second <Server> — a plan declares server work once", () => {
    const result = compilePlan(
      `<Plan name="Two servers"><Group><Leaf component="StatTile" purpose="Total"/></Group>
         <Server kind="steps" why="Chasing overdue invoices."/>
         <Server kind="agentic" why="Judgment calls every run."/></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual(["a plan declares server work once — the second <Server> was dropped."]);
    expect(result.plan?.server?.kind).toBe("steps");
  });

  it("drops server work with no why explaining the escape", () => {
    const result = compilePlan(
      `<Plan name="No why"><Group><Leaf component="StatTile" purpose="Total"/></Group>
         <Server kind="steps"/></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([
      "<Server> needs a why saying in one sentence why this cannot happen in the browser — the escape has to be earned. The server work was dropped.",
    ]);
    expect(result.plan?.server).toBeUndefined();
  });

  it("ignores an <Island> written with content instead of self-closing", () => {
    const result = compilePlan(
      `<Plan name="Island with content"><Group><Leaf component="StatTile" purpose="Total"/></Group>
         <Island name="RunwayDial" purpose="A cash dial">oops</Island></Plan>`,
      FACTS,
    );
    expect(result.issues).toContain(
      "<Island> holds nothing here — the plan only names it; its content was ignored.",
    );
    expect(result.plan?.island).toStrictEqual({ name: "RunwayDial", purpose: "A cash dial" });
  });

  it("drops a second <Island> — a plan asks for one at most", () => {
    const result = compilePlan(
      `<Plan name="Two islands"><Group><Leaf component="StatTile" purpose="Total"/></Group>
         <Island name="RunwayDial" purpose="A cash dial"/>
         <Island name="BurnGauge" purpose="A burn gauge"/></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual(["a plan asks for one island at most — the second <Island> was dropped."]);
    expect(result.plan?.island?.name).toBe("RunwayDial");
  });

  it("drops an island missing a name or a purpose", () => {
    const result = compilePlan(
      `<Plan name="Bad island"><Group><Leaf component="StatTile" purpose="Total"/></Group>
         <Island purpose="A cash dial no chart component can express"/></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual([
      'an <Island> needs a name and a purpose — <Island name="RunwayDial" purpose="..."/> — so it can be built and screened. It was dropped.',
    ]);
    expect(result.plan?.island).toBeUndefined();
  });

  it("truncates a <Cannot> with no closing tag", () => {
    const result = compilePlan(
      `<Plan name="Unclosed cannot"><Group><Leaf component="StatTile" purpose="Total"/></Group>
         <Cannot>Your host has no way to send email`,
      FACTS,
    );
    expect(result.plan?.cannot).toEqual([]);
    expect(result.issues).toEqual([
      "the plan ended before </Plan>, so it was read only as far as it got. Write it again whole.",
    ]);
  });

  it("reports loose text sitting directly inside <Plan>", () => {
    const result = compilePlan(
      `<Plan name="Loose top level">
           some stray narration here
           <Group tab="Overview"><Leaf component="StatTile" purpose="Total outstanding"/></Group>
         </Plan>`,
      FACTS,
    );
    expect(result.issues).toContain(
      '"some stray narration here" sits loose inside <Plan>, where only elements mean anything; it was ignored. An explanation belongs in a <Cannot> line or a leaf\'s purpose.',
    );
  });

  it("ignores a stray close tag that matches nothing open", () => {
    const result = compilePlan(
      `<Plan name="Stray close"></Foo><Group tab="Overview"><Leaf component="StatTile" purpose="Total outstanding"/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toEqual(["</Foo> closes nothing that is open here; it was ignored."]);
  });

  it("stops cleanly on a lone trailing '<' directly inside <Plan>", () => {
    const result = compilePlan(
      `<Plan name="Trailing top level"><Group tab="Overview"><Leaf component="StatTile" purpose="Total outstanding"/></Group><`,
      FACTS,
    );
    expect(result.plan?.groups[0]?.leaves).toStrictEqual([{ component: "StatTile", purpose: "Total outstanding" }]);
    expect(result.issues).toEqual([
      "the plan ended before </Plan>, so it was read only as far as it got. Write it again whole.",
    ]);
  });

  it("drops a <Leaf> written straight inside the plan, not inside a group", () => {
    const result = compilePlan(
      `<Plan name="Stray leaf"><Leaf component="StatTile" purpose="Total outstanding"/>
         <Group tab="Overview"><Leaf component="BarChart" purpose="Invoiced amount"/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toContain(
      "a <Leaf> belongs inside a <Group>, never straight in the plan — the group is what one worker writes. It was dropped.",
    );
  });

  it("drops a tag that is not part of the plan grammar", () => {
    const result = compilePlan(
      `<Plan name="Odd tag"><Foo>some content</Foo>
         <Group tab="Overview"><Leaf component="StatTile" purpose="Total outstanding"/></Group></Plan>`,
      FACTS,
    );
    expect(result.issues).toContain(
      "<Foo> is not part of a plan, which holds <Query>, <Group> (of <Leaf> elements), <Server>, <Island> and <Cannot>. It was dropped.",
    );
    expect(result.plan?.groups[0]?.leaves).toStrictEqual([{ component: "StatTile", purpose: "Total outstanding" }]);
  });

  it("reports a <Plan> tag truncated before it closed", () => {
    const result = compilePlan('<Plan name="Cut off', FACTS);
    expect(result).toStrictEqual({
      issues: ["the <Plan ...> tag was cut off before it closed, so there was no plan to read."],
    });
  });

  it("says a plan with no groups and no <Cannot> lines says nothing", () => {
    const result = compilePlan('<Plan name="Empty"></Plan>', FACTS);
    expect(result.issues).toEqual([
      "this plan says nothing: it needs at least one <Group> of leaves, or a <Cannot> line explaining honestly why the ask cannot be built here.",
    ]);
    expect(result.plan).toStrictEqual({ name: "Empty", queries: [], groups: [], cannot: [] });
  });

  /**
   * Layer 3 — the machine serves the whole app surface. Declared in the PLAN
   * because flipping deletes the app's tree: a box that decides on its own that
   * it serves UI must never replace a tree the person did not ask to lose.
   */
  describe("<Server served> — the layer-3 declaration", () => {
    const planWith = (server: string) => compilePlan(
      `<Plan name="Board">
         <Group tab="Board"><Leaf component="StatTile" purpose="Something"/></Group>
         ${server}
       </Plan>`,
      FACTS,
    );

    it("reads the bare served flag on a box, and says nothing about it otherwise", () => {
      const result = planWith('<Server kind="box" served why="Drag-and-drop between columns is an interaction no component can express."/>');
      expect(result.issues).toEqual([]);
      expect(result.plan?.server).toEqual({
        kind: "box",
        served: true,
        why: "Drag-and-drop between columns is an interaction no component can express.",
      });
    });

    it("leaves served absent when it was never declared", () => {
      const result = planWith('<Server kind="box" why="Custom matching logic no tool composition can express."/>');
      expect(result.issues).toEqual([]);
      expect(result.plan?.server?.served).toBeUndefined();
    });

    it("refuses served on an automation — only a machine can serve a surface", () => {
      const result = planWith('<Server kind="steps" served schedule="fridays" why="Nobody has the app open on a Friday."/>');
      expect(result.plan?.server?.served).toBeUndefined();
      expect(result.issues.join(" ")).toContain('only kind="box"');
    });

    it("teaches the bare-flag form when served carries a value", () => {
      const result = planWith('<Server kind="box" served="yes" why="Drag-and-drop between columns."/>');
      expect(result.plan?.server?.served).toBeUndefined();
      expect(result.issues.join(" ")).toContain("bare flag");
    });

    it("accepts a box-served plan with zero groups — the whole surface is the box", () => {
      const result = compilePlan(
        `<Plan name="Board">
           <Server kind="box" served why="Drag-and-drop between columns is an interaction no component can express."/>
         </Plan>`,
        FACTS,
      );
      expect(result.issues).toEqual([]);
      expect(result.plan?.server).toEqual({
        kind: "box",
        served: true,
        why: "Drag-and-drop between columns is an interaction no component can express.",
      });
    });
  });

  describe("the display hint (redesign spec §5)", () => {
    const planNamed = (head: string) => compilePlan(
      `<${head}>
         <Group tab="Board"><Leaf component="StatTile" purpose="Something"/></Group>
       </Plan>`,
      FACTS,
    );

    it('reads display="stage" off the plan head', () => {
      const result = planNamed('Plan name="Money HQ" display="stage"');
      expect(result.issues).toEqual([]);
      expect(result.plan?.display).toBe("stage");
    });

    it('reads display="inline"', () => {
      const result = planNamed('Plan name="Balance" display="inline"');
      expect(result.issues).toEqual([]);
      expect(result.plan?.display).toBe("inline");
    });

    it("leaves it absent when the plan never declares one — inline is the default", () => {
      const result = planNamed('Plan name="Balance"');
      expect(result.issues).toEqual([]);
      expect(result.plan).not.toHaveProperty("display");
    });

    it("drops a display nobody can render and says what the two values are", () => {
      const result = planNamed('Plan name="Balance" display="fullscreen"');
      expect(result.plan?.display).toBeUndefined();
      expect(result.issues.join(" ")).toContain('display is "inline" or "stage"');
    });
  });
});
