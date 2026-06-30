import { z } from "zod";
import { prewired } from "../../descriptor";

export const tableSchema = z.object({
  caption: z.string().optional(),
  columns: z.array(z.object({ key: z.string(), label: z.string() })).min(1),
  rows: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
});

export const tableDescriptor = prewired(
  "Table",
  "A data table with labeled columns and rows of records. Use to list structured rows such as transactions, items, or comparisons.",
  tableSchema,
);
