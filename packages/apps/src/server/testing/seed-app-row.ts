import type {
  AppDocument,
} from "../../contract/index.js";
import type { EngineOps } from "../persistence/engine.js";
import { APPS_COLLECTION } from "../persistence/persistence.js";

/** Seed an app using the reserved vendo_apps row shape. */
export const seedAppRow = (
  engine: EngineOps,
  app: AppDocument,
  subject: string,
  enabled = false,
) =>
  engine.put(APPS_COLLECTION, {
    id: app.id,
    data: { subject, enabled, doc: app },
    refs: { subject },
  });
