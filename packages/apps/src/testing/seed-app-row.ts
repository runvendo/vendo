import type { AppDocument, StoreAdapter } from "@vendoai/core";

/** Seed an app using the reserved vendo_apps row shape. */
export const seedAppRow = (
  store: StoreAdapter,
  app: AppDocument,
  subject: string,
  enabled = false,
) =>
  store.records("vendo_apps").put({
    id: app.id,
    data: { subject, enabled, doc: app },
    refs: { subject },
  });
