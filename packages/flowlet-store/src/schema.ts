import { pgSchema, text, integer, boolean, jsonb, timestamp, primaryKey, uniqueIndex, index, bigserial } from "drizzle-orm/pg-core";

export const flowlet = pgSchema("flowlet");

export const automations = flowlet.table("automations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  disabledReason: text("disabled_reason"),
  spec: jsonb("spec").notNull(),
  currentVersion: integer("current_version").notNull(),
  triggerKind: text("trigger_kind").notNull(),
  triggerKey: text("trigger_key"),
  counters: jsonb("counters").notNull(),
  createdFromThreadId: text("created_from_thread_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [index("automations_scope_idx").on(t.tenantId, t.subject), index("automations_trigger_idx").on(t.triggerKind, t.triggerKey)]);

export const automationVersions = flowlet.table("automation_versions", {
  automationId: text("automation_id").notNull(),
  version: integer("version").notNull(),
  spec: jsonb("spec").notNull(),
  dslVersion: integer("dsl_version").notNull(),
  manifestHash: text("manifest_hash"),
  grants: jsonb("grants").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [primaryKey({ columns: [t.automationId, t.version] })]);

export const automationRuns = flowlet.table("automation_runs", {
  id: text("id").primaryKey(), // firingRunId — DB-level double-fire dedup
  automationId: text("automation_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  version: integer("version").notNull(),
  manifestHash: text("manifest_hash"),
  status: text("status").notNull(),
  outcome: text("outcome"),
  trigger: jsonb("trigger").notNull(),
  steps: jsonb("steps").notNull(),
  pendingApproval: jsonb("pending_approval"),
  error: text("error"),
  isTest: boolean("is_test").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
}, (t) => [index("runs_automation_idx").on(t.automationId, t.tenantId, t.subject)]);

export const decisions = flowlet.table("decisions", {
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  canonicalKey: text("canonical_key").notNull(),
  decision: jsonb("decision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.subject, t.canonicalKey] })]);

export const threads = flowlet.table("threads", {
  id: text("id").notNull(),
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  title: text("title"),
  nextSeq: integer("next_seq").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.subject, t.id] })]);

export const threadMessages = flowlet.table("thread_messages", {
  rowId: bigserial("row_id", { mode: "number" }).primaryKey(),
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  threadId: text("thread_id").notNull(),
  messageId: text("message_id").notNull(),
  seq: integer("seq").notNull(),
  message: jsonb("message").notNull(),
}, (t) => [
  uniqueIndex("thread_messages_id_uq").on(t.tenantId, t.subject, t.threadId, t.messageId),
  uniqueIndex("thread_messages_seq_uq").on(t.tenantId, t.subject, t.threadId, t.seq),
]);

export const savedFlowlets = flowlet.table("saved_flowlets", {
  id: text("id").notNull(),
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  record: jsonb("record").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.subject, t.id] })]);

export const connections = flowlet.table("connections", {
  toolkit: text("toolkit").notNull(),
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  connectedAccountId: text("connected_account_id"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.subject, t.toolkit] }),
  index("connections_account_idx").on(t.connectedAccountId),
]);

/** Tiny operational KV (scheduler heartbeat, future flags). NOT for domain data. */
export const meta = flowlet.table("meta", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
});
