// Re-exported so consumers build queries against the same drizzle-orm instance
// this package resolved.
export { and, desc, eq } from "drizzle-orm";
export { createVendoDatabase, migrateVendoDatabase } from "./db.js";
export type { VendoDatabaseConfig, VendoDb } from "./db.js";
export {
  vendo,
  automations,
  automationVersions,
  automationRuns,
  decisions,
  threads,
  threadMessages,
  connections,
  meta,
} from "./schema.js";
export { getMeta, setMeta } from "./meta.js";
export { DrizzleAutomationStore, toIso } from "./automation-store.js";
export { createDrizzleDecisionStore } from "./decision-store.js";
export { createDrizzleThreadStore } from "./thread-store.js";
export { createDrizzleConnectionsStore } from "./connections-store.js";
export type { DurableConnectionsStore, IntegrationCatalogEntry } from "./connections-store.js";
