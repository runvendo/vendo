import type { ComponentRegistry } from "@vendoai/core";
import { z } from "zod";
import { Sparkline } from "@/components/charts/sparkline";
import { Donut } from "@/components/charts/donut";
import { NetWorthView } from "@/components/home/net-worth-view";
import type { SpendingSlice } from "@/server/types";

function MapleSparkline({ data, height = 28 }: { data: number[]; height?: number }) {
  return (
    <div style={{ height }}>
      <Sparkline data={data} height={height} stroke="var(--vendo-color-text, #14151A)" />
    </div>
  );
}

function MapleSpendingDonut({
  slices,
  size = 200,
}: {
  slices: Array<{ category: SpendingSlice["category"]; amount: number }>;
  size?: number;
}) {
  // W3 — Maple money is integer CENTS everywhere (the spending-insights API
  // included); the old dollars surface silently 100×'d bound tool data.
  return <Donut data={slices.map((slice) => ({ ...slice, amount: Math.round(slice.amount) }))} size={size} />;
}

const mapleCategorySchema = z.enum([
  "dining",
  "groceries",
  "coffee",
  "transport",
  "subscriptions",
  "shopping",
  "income",
  "transfer",
  "housing",
  "other",
]);

/**
 * The ONE Maple component registry (01 §14, 08 §2 — server-wiring DX):
 * defined once, imported by both sides. `createVendo` takes it as `catalog`
 * and reads only the data fields (description/props/examples); `<VendoRoot>`
 * takes it as `components` and reads only the component references.
 */
export const mapleRegistry = {
  MapleSparkline: {
    component: MapleSparkline,
    description: "The default Maple visualization for a compact financial trend, history, change over time, or monthly trend. Use it whenever the request includes one of those intents.",
    props: z.object({
      data: z.array(z.number()),
      height: z.number().optional(),
    }),
    examples: ['{"data":[1280,1315,1298,1360,1412],"height":32}'],
  },
  MapleSpendingDonut: {
    component: MapleSpendingDonut,
    description: "The default Maple visualization for spending by category, where money went, or category mix. Use it whenever the request includes one of those intents; slice amounts are integer CENTS (matching the spending-insights tool).",
    props: z.object({
      slices: z.array(z.object({
        category: mapleCategorySchema,
        amount: z.number().describe("Amount in integer cents"),
      })),
      size: z.number().optional(),
    }),
    examples: [
      '{"slices":[{"category":"dining","amount":34218},{"category":"groceries","amount":28642}],"size":200}',
    ],
  },
  MapleNetWorthCard: {
    component: NetWorthView,
    description: "The Maple total-balance card: animated USD total, change badge, range switcher, and an area trend of the balance history. Use it for net worth, total balance, or balance-over-time requests. Values are integer cents.",
    props: z.object({
      valueCents: z.number().describe("Total balance in integer cents"),
      series: z.array(z.number()).describe("Balance history in integer cents"),
      changeLabel: z.string().optional(),
      initialRange: z.enum(["1W", "1M", "3M", "1Y", "All"]).optional(),
      chartHeight: z.number().optional(),
    }),
    examples: [
      '{"valueCents":5490715,"series":[5329117,5446991,5589669,5679262,5733114,5794065,5901309,5748395],"changeLabel":"▲ 2.3% this month"}',
    ],
  },
} satisfies ComponentRegistry;

/**
 * Remixable host slots (06-apps §8), statically captured by `vendo sync` into
 * `.vendo/remixable/<slot>.json`. `sampleProps` mirror the deterministic demo
 * seed (src/server/seed.ts) so a fork previews with the numbers the real home
 * page shows. `exportable: true` lets forks of this card leave with the app.
 */
export const mapleRemixableComponents = [
  {
    name: "MapleNetWorthCard",
    component: NetWorthView,
    remixable: true,
    exportable: true,
    sampleProps: {
      valueCents: 5490715,
      changeLabel: "▲ 2.3% this month",
      series: [
        5329117, 5370611, 5368877, 5446991, 5463873, 5481959, 5548758, 5589669,
        5608978, 5665236, 5679262, 5643739, 5674695, 5664232, 5733114, 5720586,
        5755865, 5794065, 5846760, 5870599, 5901309, 5891485, 5876491, 5870571,
        5748395,
      ],
    },
  },
];
