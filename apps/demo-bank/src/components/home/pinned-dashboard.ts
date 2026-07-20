import type { UIPayload } from "@vendoai/core";

/** ENG-230 — the Maple home slot's pinned dashboard: a `vendo-genui/v2` tree
 *  mounted in place through the ENG-223 pin path (no server round trip), so the
 *  slot's FILLED state is reachable in the demo. Uses Maple's own catalog
 *  components (MapleSparkline, MapleSpendingDonut) for brand fidelity. */
export const maplePinnedDashboard: UIPayload = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [
    { id: "root", component: "Surface", children: ["stack"] },
    { id: "stack", component: "Stack", props: { gap: 14 }, children: ["title", "trend", "sub", "donut"] },
    { id: "title", component: "Text", props: { text: "This month at a glance", variant: "heading" } },
    { id: "trend", component: "MapleSparkline", props: { data: [1280, 1315, 1298, 1360, 1412, 1520], height: 40 } },
    { id: "sub", component: "Text", props: { text: "Spending by category", variant: "muted" } },
    {
      id: "donut",
      component: "MapleSpendingDonut",
      props: {
        // Amounts are integer cents (the donut matches the spending API).
        slices: [
          { category: "groceries", amount: 42000 },
          { category: "dining", amount: 28500 },
          { category: "subscriptions", amount: 9600 },
          { category: "transport", amount: 14000 },
        ],
        size: 148,
      },
    },
  ],
};
