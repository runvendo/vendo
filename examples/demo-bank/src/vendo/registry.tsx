import type {
  ComponentRegistry,
} from "@vendoai/apps/contract";
import { z } from "zod";
import { Sparkline } from "../components/charts/sparkline";
import { Donut } from "../components/charts/donut";
import { NetWorthView } from "../components/home/net-worth-view";
import type { SpendingSlice } from "../server/types";

function MapleSparkline({ data, height = 28 }: { data: number[]; height?: number }) {
  // Mid-stream renders can mount the component before its props bind (the
  // 2026-07 walkthrough crashed here); render nothing until data arrives.
  if (!data?.length) return null;
  return (
    <div style={{ height }}>
      <Sparkline data={data} height={height} stroke="var(--vendo-color-text, #1a1a1e)" />
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
  // Mid-stream renders can mount the component before its props bind (the
  // 2026-07 walkthrough crashed here); render nothing until slices arrive.
  if (!slices?.length) return null;
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
    description: "The default Maple visualization for spending by category, where money went, or category mix. Use it whenever the request includes one of those intents. `slices` takes the ARRAY of category rows: bind it to the spending-insights tool's `data` array (host_getSpendingInsights({}).data), never to the response body itself — the body is the { data: [...] } wrapper and binding it renders an empty card. Slice amounts are integer CENTS (matching that tool).",
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

