import type { ComponentType } from "react";
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
  return <Donut data={slices.map((slice) => ({ ...slice, amount: Math.round(slice.amount * 100) }))} size={size} />;
}

/** Host component registration by name (08-ui §2). */
export const mapleHostComponents: Record<string, ComponentType> = {
  MapleSparkline: MapleSparkline as ComponentType,
  MapleSpendingDonut: MapleSpendingDonut as ComponentType,
  MapleNetWorthCard: NetWorthView as ComponentType,
};

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
