/**
 * Embedded implementations of all five frozen seams, for tests and in-process
 * (embedded) deployments. The Scheduler's embedded implementation is
 * InProcessScheduler (src/automations/in-process-scheduler.ts, ENG-188) and
 * the automations sub-store is InMemoryAutomationStore (src/automations/
 * store.ts) — both re-exported here so this barrel covers the full set.
 */
export {
  createInMemoryStore,
  InMemoryAuditLog,
  InMemoryRemixStore,
  InMemorySavedVendoStore,
  InMemoryThreadStore,
  type InMemoryStore,
} from "./in-memory-store.js";
export {
  InProcessCredentialBroker,
  type InProcessCredentialBrokerConfig,
} from "./in-process-credential-broker.js";
export { InProcessExecutor, type InProcessToolFn } from "./in-process-executor.js";
export {
  InAppChannels,
  type InAppChannelsConfig,
  type RetainedDelivery,
} from "./in-app-channels.js";
export { InMemoryAutomationStore } from "../automations/store.js";
export { InProcessScheduler } from "../automations/in-process-scheduler.js";
