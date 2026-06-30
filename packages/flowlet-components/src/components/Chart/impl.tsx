import type { ReactNode } from "react";
import { BarChart, LineChart, AreaChart, PieChart } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { chartSchema } from "./descriptor";

export const Chart = createPrewiredImpl(chartSchema, (p) => {
  const slim = p.data.map((row) => {
    const out: Record<string, unknown> = { [p.categoryKey]: row[p.categoryKey] };
    for (const s of p.series) out[s] = row[s];
    return out;
  });

  const commonProps = {
    data: slim as Record<string, string | number>[],
    categoryKey: p.categoryKey,
    width: 400,
    height: 300,
    isAnimationActive: false,
  };

  let chart: ReactNode;
  switch (p.kind) {
    case "bar":
      chart = <BarChart {...commonProps} />;
      break;
    case "line":
      chart = <LineChart {...commonProps} />;
      break;
    case "area":
      chart = <AreaChart {...commonProps} />;
      break;
    case "pie":
      chart = <PieChart {...commonProps} dataKey={p.series[0] as string} />;
      break;
  }

  return (
    <>
      {p.title ? <h3>{p.title}</h3> : null}
      {chart}
    </>
  );
});
