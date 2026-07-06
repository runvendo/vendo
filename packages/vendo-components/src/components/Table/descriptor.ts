import { z } from "zod";
import { manifestFieldFormatSchema } from "@vendoai/core";
import { prewired } from "../../descriptor.js";

export const tableSchema = z.object({
  caption: z.string().optional(),
  // `format` is the manifest's FieldFormat vocabulary (cents/iso-date/
  // iso-datetime/percent): data-bound refreshable views feed the Table RAW
  // tool rows, so a declared result-field format must be applied at RENDER
  // time — the authoring model can't format values it never round-trips.
  columns: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        format: manifestFieldFormatSchema.optional(),
      }),
    )
    .min(1)
    .max(50),
  // Records of UNKNOWN values: data-bound refreshable views feed the Table raw
  // tool rows, which legitimately carry nested fields (statusTimeline arrays,
  // metadata objects). The impl renders only the declared columns and shows an
  // em dash for a non-scalar cell — rejecting the whole row set here breaks
  // every bound view over rich rows (live voice check, 2026-07-04).
  rows: z.array(z.record(z.unknown())).max(1000),
});

export const tableDescriptor = prewired(
  "Table",
  "A data table with labeled columns and rows of records. Use to list structured rows such as transactions, items, or comparisons.",
  tableSchema,
);
