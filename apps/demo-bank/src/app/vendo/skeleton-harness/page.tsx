/**
 * DEV HARNESS (generation pipeline rebuild, Task 5) — not part of the Maple
 * product surface. It renders `skeletonFromPlan` output for two hardcoded
 * plans through the production renderer, so the plan→layout step and its
 * pending shimmer can be seen in a real browser instead of asserted in jsdom.
 *
 * Server component on purpose: `@vendoai/apps` is server-side, so the plans are
 * turned into trees here and only plain JSON crosses into the client.
 */
import { skeletonFromPlan } from "@vendoai/apps";
import type { AppPlan } from "@vendoai/core";
import { SkeletonHarness } from "./harness";

const tabbed: AppPlan = {
  name: "Invoices workspace",
  queries: [],
  groups: [
    {
      tab: "Overview",
      title: "Receivables health",
      layout: "grid",
      leaves: [
        { component: "Stat", purpose: "outstanding total" },
        { component: "Stat", purpose: "overdue total" },
        { component: "Stat", purpose: "paid this month" },
      ],
    },
    {
      tab: "Overview",
      title: "Invoiced per month",
      leaves: [{ component: "BarChart", purpose: "invoiced per month, last twelve" }],
    },
    {
      tab: "Overdue",
      title: "Worst first",
      leaves: [
        { component: "DataTable", purpose: "overdue invoices, worst first" },
        { component: "Button", purpose: "chase the worst one" },
      ],
    },
    {
      tab: "Payments",
      title: "Payment history",
      leaves: [{ component: "CardList", purpose: "recent payments" }],
    },
  ],
  cannot: [],
};

const single: AppPlan = {
  name: "Account balances",
  queries: [],
  groups: [
    {
      title: "Balances",
      layout: "grid",
      leaves: [
        { component: "Stat", purpose: "checking balance" },
        { component: "Stat", purpose: "savings balance" },
      ],
    },
    {
      title: "Recent transactions",
      leaves: [{ component: "DataTable", purpose: "last thirty transactions" }],
    },
  ],
  cannot: [],
};

export default function SkeletonHarnessPage() {
  const tabbedSkeleton = skeletonFromPlan(tabbed);
  const singleSkeleton = skeletonFromPlan(single);
  return (
    <SkeletonHarness
      tabbed={{ root: tabbedSkeleton.tree.root, nodes: tabbedSkeleton.tree.nodes }}
      single={{ root: singleSkeleton.tree.root, nodes: singleSkeleton.tree.nodes }}
    />
  );
}
