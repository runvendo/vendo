/**
 * The deterministic skeleton: a plan becomes the app's REAL layout the moment
 * the plan lands — tab chrome from the group labels and one shimmering
 * placeholder per leaf.
 *
 * The load-bearing property is streaming-prefix stability: the skeleton of a
 * PREFIX of the plan must mint the same ids as the skeleton of the whole plan,
 * so a plan arriving group by group makes the UI GROW instead of re-mounting.
 */
import {
  validateTree,
  type AppPlan,
} from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { skeletonFromPlan } from "../../src/server/generation/skeleton.js";

const plan = (groups: AppPlan["groups"], extra: Partial<AppPlan> = {}): AppPlan => ({
  name: "Invoices",
  queries: [],
  groups,
  cannot: [],
  ...extra,
});

const tabbed = plan([
  {
    tab: "Overview",
    title: "Health",
    leaves: [
      { component: "Stat", purpose: "outstanding total" },
      { component: "BarChart", purpose: "invoiced per month" },
    ],
  },
  {
    tab: "Overdue",
    title: "Worst first",
    layout: "grid",
    leaves: [{ component: "DataTable", purpose: "overdue invoices, worst first" }],
  },
  {
    tab: "Overview",
    leaves: [{ component: "CardList", purpose: "recent payments" }],
  },
]);

const node = (skeleton: ReturnType<typeof skeletonFromPlan>, id: string) =>
  skeleton.tree.nodes.find((candidate) => candidate.id === id);

describe("skeletonFromPlan", () => {
  it("gives a tabbed plan tab chrome carrying the tab titles, in order of first appearance", () => {
    const skeleton = skeletonFromPlan(tabbed);
    const chrome = skeleton.tree.nodes.find((candidate) => candidate.component === "Tabs");
    expect(chrome?.props?.tabs).toEqual([
      { value: "Overview", label: "Overview" },
      { value: "Overdue", label: "Overdue" },
    ]);
    // One panel per tab, nested under the bar so the bar owns the switch.
    expect(node(skeleton, skeleton.tree.root)?.children).toEqual(["tabs"]);
    expect(chrome?.children).toEqual(["tab-0", "tab-1"]);
    // The two Overview groups share one panel; the panel holds them in plan order.
    const panels = skeleton.tree.nodes.filter((candidate) => candidate.id.startsWith("tab-"));
    expect(panels.map((panel) => panel.children)).toEqual([["group-0", "group-2"], ["group-1"]]);
    expect(validateTree(skeleton.tree).ok).toBe(true);
  });

  it("renders every leaf as one pending placeholder inside its group's body", () => {
    const skeleton = skeletonFromPlan(tabbed);
    const placeholders = skeleton.tree.nodes.filter((candidate) => candidate.props?.pending === true);
    expect(placeholders).toEqual([
      { id: "group-0-leaf-0", component: "Stat", source: "prewired", props: { pending: true } },
      { id: "group-0-leaf-1", component: "BarChart", source: "prewired", props: { pending: true } },
      { id: "group-1-leaf-0", component: "DataTable", source: "prewired", props: { pending: true } },
      { id: "group-2-leaf-0", component: "CardList", source: "prewired", props: { pending: true } },
    ]);
    // Each group's body is the container that holds exactly that group's
    // placeholders.
    expect(node(skeleton, "group-0-body")?.children).toEqual(["group-0-leaf-0", "group-0-leaf-1"]);
    // A group's title is chrome the worker never has to rewrite; `layout` picks
    // the slot's container.
    expect(node(skeleton, "group-0-title")?.props).toEqual({ text: "Health", variant: "heading" });
    expect(node(skeleton, "group-1-body")?.component).toBe("Grid");
    expect(node(skeleton, "group-1-body")?.props).toEqual({ columns: 1 });
    expect(node(skeleton, "group-0-body")?.component).toBe("Stack");
  });

  it("gives a plan with no tab labels a single surface and no tab chrome", () => {
    const skeleton = skeletonFromPlan(plan([
      { title: "Balances", leaves: [{ component: "Stat", purpose: "balance" }] },
      { leaves: [{ component: "DataTable", purpose: "transactions" }] },
    ]));
    expect(skeleton.tree.nodes.some((candidate) => candidate.component === "Tabs")).toBe(false);
    expect(node(skeleton, skeleton.tree.root)?.children).toEqual(["group-0", "group-1"]);
    expect(validateTree(skeleton.tree).ok).toBe(true);
  });

  it("carries the plan's queries onto the tree so fragments have something to bind to", () => {
    const skeleton = skeletonFromPlan(plan(
      [{ leaves: [{ component: "DataTable", purpose: "invoices" }] }],
      { queries: [{ id: "invoices", tool: "host_listInvoices", input: { status: "overdue" } }] },
    ));
    expect(skeleton.tree.queries).toEqual([
      { name: "invoices", tool: "host_listInvoices", input: { status: "overdue" } },
    ]);
  });

  it("STREAMING-PREFIX STABILITY: a prefix plan's ids are the full skeleton's, unchanged", () => {
    const full = skeletonFromPlan(tabbed);
    const fullIds = new Set(full.tree.nodes.map((candidate) => candidate.id));

    for (let count = 1; count <= tabbed.groups.length; count += 1) {
      const prefix = skeletonFromPlan({ ...tabbed, groups: tabbed.groups.slice(0, count) });
      // No id may change, so ids can never be derived from what comes LATER
      // (a count, a total, a hash of the whole plan).
      for (const candidate of prefix.tree.nodes) {
        expect(fullIds.has(candidate.id), `prefix ${count} minted unknown id "${candidate.id}"`).toBe(true);
      }
      // The UI grows: every surviving parent keeps its children in place and
      // only appends, so React re-mounts nothing.
      for (const candidate of prefix.tree.nodes) {
        const grown = node(full, candidate.id);
        expect(grown?.children ?? []).toEqual(
          expect.arrayContaining(candidate.children ?? []),
        );
        expect((grown?.children ?? []).slice(0, (candidate.children ?? []).length))
          .toEqual(candidate.children ?? []);
      }
    }
  });
});
