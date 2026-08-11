/**
 * `AppRow` — the stored app row, one definition.
 *
 * The row was declared five times: the store's DB projection
 * (`store/src/helpers/types.ts`), the automations engine's read shape
 * (`automations/src/types.ts`, with its own zod), the persistence layer's
 * `AppRowData`, a structural alias in `write-surface.ts`, and a narrower mirror
 * in the umbrella's sync reader. They agreed by luck, not by construction.
 *
 * The document alone is NOT the row: ownership (`subject`) and the automations
 * arm/disarm bit (`enabled`) ride beside it, and the store adds identity and
 * write bookkeeping around both.
 */
import { appDocumentSchema, type AppDocument, type AppId, type IsoDateTime } from "@vendoai/core";
import { z } from "zod";

/** 02-store §3 — the whole row as a store hands it back. */
export interface AppRow {
  id: AppId;
  subject: string;
  enabled: boolean;
  doc: AppDocument;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Opaque write counter backing the routed atomic capability (01 §12); bumped
   *  on every write. Wave 7 — arbitration for the machine lifecycle and the
   *  schedule engine's fire claims (updateAppRow's read-mutate-CAS). */
  revision?: string;
}

/**
 * The half of the row a `VendoRecord` CARRIES — everything the writer supplies.
 * `id` is the record's own id and the timestamps and `revision` are the store's
 * bookkeeping, so a generic `StoreAdapter` never sees them in `data`.
 */
export type AppData = Pick<AppRow, "subject" | "enabled" | "doc">;

/** The parse of a stored row's `data`. Named for the row it belongs to; it
 *  covers {@link AppData} because that is the part anyone writes. */
export const appRowSchema = z.object({
  subject: z.string(),
  enabled: z.boolean(),
  doc: appDocumentSchema,
});
