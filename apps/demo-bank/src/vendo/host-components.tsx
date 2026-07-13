import type { ComponentType } from "react";
import { Sparkline } from "@/components/charts/sparkline";
import { Donut } from "@/components/charts/donut";
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
};
