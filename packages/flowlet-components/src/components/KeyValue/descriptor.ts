import { z } from "zod";
import { prewired } from "../../descriptor";

export const keyValueSchema = z.object({
  title: z.string().optional(),
  rows: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        /** Render the value heavier — for the row that matters (e.g. Amount). */
        emphasis: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(30),
});

export const keyValueDescriptor = prewired(
  "KeyValue",
  "A detail card body: rows of muted label (left) and value (right, tabular " +
    "numerals). THE component for showing one record's details — a transaction, " +
    "an account, an order. Set emphasis on the key row (e.g. the amount).",
  keyValueSchema,
);
