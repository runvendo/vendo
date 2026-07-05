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
  InMemorySavedFlowletStore,
  InMemoryThreadStore,
  type InMemoryStore,
} from "./in-memory-store";
export {
  InProcessCredentialBroker,
  type InProcessCredentialBrokerConfig,
} from "./in-process-credential-broker";
export { InProcessExecutor, type InProcessToolFn } from "./in-process-executor";
export {
  InAppChannels,
  type InAppChannelsConfig,
  type RetainedDelivery,
} from "./in-app-channels";
export { InMemoryAutomationStore } from "../automations/store";
export { InProcessScheduler } from "../automations/in-process-scheduler";
