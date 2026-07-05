// Re-exported so consumers (e.g. @flowlet/next's flowlets.ts) build queries
// against the SAME drizzle-orm instance this package resolved — a consumer
// declaring its own `drizzle-orm` dependency can land on a different
// peer-hashed copy in pnpm's node_modules, which breaks structurally (the
// `Column`/`SQL` classes carry a private field, so TS sees two incompatible
// nominal types even though the runtime code is identical).
export { and, desc, eq } from "drizzle-orm";
export { createFlowletDatabase, migrateFlowletDatabase } from "./db.js";
export type { FlowletDatabaseConfig, FlowletDb } from "./db.js";
export {
  flowlet,
  automations,
  automationVersions,
  automationRuns,
  decisions,
  threads,
  threadMessages,
  savedFlowlets,
  connections,
  meta,
} from "./schema.js";
export { getMeta, setMeta } from "./meta.js";
export { DrizzleAutomationStore, toIso } from "./automation-store.js";
export { createDrizzleDecisionStore } from "./decision-store.js";
export { createDrizzleThreadStore } from "./thread-store.js";
export { createDrizzleSavedFlowletStore } from "./flowlet-registry.js";
export { createDrizzleConnectionsStore } from "./connections-store.js";
export type { DurableConnectionsStore, IntegrationCatalogEntry } from "./connections-store.js";
