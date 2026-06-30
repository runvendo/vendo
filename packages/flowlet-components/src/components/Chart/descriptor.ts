import { z } from "zod";
import { prewired } from "../../descriptor";

export const chartSchema = z.object({
  kind: z.enum(["bar", "line", "area", "pie"]),
  title: z.string().optional(),
  categoryKey: z.string(),
  series: z.array(z.string()).min(1),
  data: z.array(z.record(z.union([z.string(), z.number()]))),
});

export const chartDescriptor = prewired(
  "Chart",
  "A chart (bar, line, area, or pie) over a list of data points. `categoryKey` is the x-axis/label field; `series` lists the numeric value fields to plot. Use to visualize trends, comparisons, or distributions.",
  chartSchema,
);
