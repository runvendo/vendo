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

  switch (p.kind) {
    case "bar":
      return <BarChart {...commonProps} />;
    case "line":
      return <LineChart {...commonProps} />;
    case "area":
      return <AreaChart {...commonProps} />;
    case "pie":
      return (
        <PieChart
          {...commonProps}
          dataKey={p.series[0] as string}
        />
      );
  }
});
