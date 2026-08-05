/**
 * The deterministic skeleton (generation pipeline rebuild, Task 5): a plan
 * becomes the app's REAL layout the moment the plan lands — tab chrome from
 * the group labels, one shimmering placeholder per leaf, and a slot map the
 * fill workers splice their fragments into.
 *
 * The load-bearing property is streaming-prefix stability: the skeleton of a
 * PREFIX of the plan must mint the same ids as the skeleton of the whole plan,
 * so a plan arriving group by group makes the UI GROW instead of re-mounting.
 */
import { VENDO_TREE_FORMAT, validateTree, type AppPlan, type Tree } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { growSkeleton, skeletonFromPlan, spliceFragment } from "./skeleton.js";

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

  it("renders every leaf as one pending placeholder and records each group's fill slot", () => {
    const skeleton = skeletonFromPlan(tabbed);
    const placeholders = skeleton.tree.nodes.filter((candidate) => candidate.props?.pending === true);
    expect(placeholders).toEqual([
      { id: "group-0-leaf-0", component: "Stat", source: "prewired", props: { pending: true } },
      { id: "group-0-leaf-1", component: "BarChart", source: "prewired", props: { pending: true } },
      { id: "group-1-leaf-0", component: "DataTable", source: "prewired", props: { pending: true } },
      { id: "group-2-leaf-0", component: "CardList", source: "prewired", props: { pending: true } },
    ]);
    expect(skeleton.slots).toEqual({
      "group-0": "group-0-body",
      "group-1": "group-1-body",
      "group-2": "group-2-body",
    });
    // Each slot is the container whose children a fill fragment replaces, and
    // it holds exactly that group's placeholders.
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
      [{ leaves: [{ component: "DataTable", query: "invoices", purpose: "invoices" }] }],
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
      // And every slot the prefix reported still points at the same node.
      for (const [group, slot] of Object.entries(prefix.slots)) {
        expect(full.slots[group]).toBe(slot);
      }
    }
  });
});

/**
 * An AMENDMENT grows a live app: the brain planned only the NEW parts, and the
 * tree they land in is already filled and already on somebody's screen. The
 * load-bearing property is that NOTHING already there moves — same ids, same
 * props, same children order — because a renamed node re-mounts under the user.
 */
describe("growSkeleton", () => {
  const live = () => skeletonFromPlan(tabbed).tree;

  const added = plan([
    { tab: "Payments", title: "Payment history", leaves: [{ component: "DataTable", purpose: "payments, newest first" }] },
  ]);

  it("starts the new groups past the highest ordinal in use and leaves every existing node byte-identical", () => {
    const before = live();
    const grown = growSkeleton(before, added);
    // tabbed ends at group-2, so an amendment starts at group-3 — never group-0.
    expect(Object.keys(grown.slots)).toEqual(["group-3"]);
    expect(grown.slots["group-3"]).toBe("group-3-body");
    for (const original of before.nodes) {
      const carried = grown.tree.nodes.find((candidate) => candidate.id === original.id);
      // The tab bar legitimately gains a tab; everything else is untouched.
      if (original.component === "Tabs") continue;
      expect(carried, `growSkeleton dropped "${original.id}"`).toEqual(original);
    }
    expect(validateTree(grown.tree).ok).toBe(true);
  });

  it("gives a NEW tab label its own tab and panel beside the existing ones", () => {
    const grown = growSkeleton(live(), added);
    const chrome = grown.tree.nodes.find((candidate) => candidate.component === "Tabs");
    expect(chrome?.props?.tabs).toEqual([
      { value: "Overview", label: "Overview" },
      { value: "Overdue", label: "Overdue" },
      { value: "Payments", label: "Payments" },
    ]);
    // Appended, never inserted: the existing panels keep their positions.
    expect(chrome?.children).toEqual(["tab-0", "tab-1", "tab-2"]);
    expect(grown.tree.nodes.find((candidate) => candidate.id === "tab-2")?.children).toEqual(["group-3"]);
  });

  it("adopts a group into a tab the app already has instead of minting a second one", () => {
    const grown = growSkeleton(live(), plan([
      { tab: "Overdue", title: "Aging buckets", leaves: [{ component: "BarChart", purpose: "aging" }] },
    ]));
    const chrome = grown.tree.nodes.find((candidate) => candidate.component === "Tabs");
    expect(chrome?.props?.tabs).toHaveLength(2);
    // The existing Overdue panel gains the group, in last position.
    expect(grown.tree.nodes.find((candidate) => candidate.id === "tab-1")?.children)
      .toEqual(["group-1", "group-3"]);
  });

  it("attaches at the root when the app has no tab chrome, rather than inventing a label for what is already there", () => {
    const flat = skeletonFromPlan(plan([
      { title: "Balances", leaves: [{ component: "Stat", purpose: "balance" }] },
    ])).tree;
    const grown = growSkeleton(flat, added);
    expect(grown.tree.nodes.some((candidate) => candidate.component === "Tabs")).toBe(false);
    expect(grown.tree.nodes.find((candidate) => candidate.id === grown.tree.root)?.children)
      .toEqual(["group-0", "group-1"]);
  });

  it("carries the amendment's own queries onto the tree without disturbing the app's", () => {
    const before = skeletonFromPlan(plan(
      [{ leaves: [{ component: "DataTable", query: "invoices", purpose: "invoices" }] }],
      { queries: [{ id: "invoices", tool: "host_listInvoices", input: {} }] },
    )).tree;
    const grown = growSkeleton(before, plan(
      [{ leaves: [{ component: "DataTable", query: "payments", purpose: "payments" }] }],
      { queries: [{ id: "payments", tool: "host_listPayments", input: {} }] },
    ));
    expect(grown.tree.queries).toEqual([
      { name: "invoices", tool: "host_listInvoices", input: {} },
      { name: "payments", tool: "host_listPayments", input: {} },
    ]);
  });
});

describe("spliceFragment", () => {
  const base: Tree = {
    formatVersion: VENDO_TREE_FORMAT,
    root: "app",
    nodes: [
      { id: "app", component: "Stack", source: "prewired", children: ["slot"] },
      { id: "slot", component: "Stack", source: "prewired", children: [] },
    ],
  };

  it("strips the plan's query/purpose vocabulary off a worker-written node's props", () => {
    const fragment: Tree = {
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "generated", children: ["stat-1"] },
        {
          id: "stat-1",
          component: "Stat",
          source: "generated",
          props: { label: "Total", value: 5, query: "invoices", purpose: "the total" },
        },
      ],
    };
    const spliced = spliceFragment(base, "slot", fragment);
    expect(spliced.nodes.find((node) => node.id === "slot-stat-1")?.props).toEqual({ label: "Total", value: 5 });
  });

  it("resolves a worker's <Leaf component=...> copy-paste to the real component it names", () => {
    const fragment: Tree = {
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "generated", children: ["leaf-1"] },
        {
          id: "leaf-1",
          component: "Leaf",
          source: "generated",
          props: { component: "Stat", query: "invoices", purpose: "the total", label: "Total" },
        },
      ],
    };
    const spliced = spliceFragment(base, "slot", fragment);
    const leaf = spliced.nodes.find((node) => node.id === "slot-leaf-1");
    expect(leaf?.component).toBe("Stat");
    expect(leaf?.props).toEqual({ label: "Total" });
  });

  it("resolves a worker's <Group> copy-paste to the Stack it always meant", () => {
    const fragment: Tree = {
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "generated", children: ["group-1"] },
        { id: "group-1", component: "Group", source: "generated", children: [] },
      ],
    };
    const spliced = spliceFragment(base, "slot", fragment);
    expect(spliced.nodes.find((node) => node.id === "slot-group-1")?.component).toBe("Stack");
  });

  it("never touches a host node's props or component name — a host may call either whatever it likes", () => {
    const fragment: Tree = {
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "generated", children: ["host-1"] },
        { id: "host-1", component: "Leaf", source: "host", props: { query: "kept", purpose: "kept", component: "kept" } },
      ],
    };
    const spliced = spliceFragment(base, "slot", fragment);
    const hostNode = spliced.nodes.find((node) => node.id === "slot-host-1");
    expect(hostNode?.component).toBe("Leaf");
    expect(hostNode?.props).toEqual({ query: "kept", purpose: "kept", component: "kept" });
  });
});
