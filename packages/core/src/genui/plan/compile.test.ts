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

  it("issues read as sentences a person could say, never error codes", () => {
    const result = compilePlan(
      `<Plan>
         <Group tab="Overview" layout="masonry">
           <Leaf purpose="Something"/>
           <Leaf component="StatTile"/>
         </Group>
         <Server kind="magic" why="Because."/>
         <Cannot></Cannot>
       </Plan>`,
      FACTS,
    );
    expect(result.issues.length).toBeGreaterThan(4);
    for (const message of result.issues) {
      expect(message.split(" ").length).toBeGreaterThan(4);
    }
  });
});
