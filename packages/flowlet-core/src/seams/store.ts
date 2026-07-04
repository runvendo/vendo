import type { FlowletUIMessage } from "../protocol";
import type { UINode } from "../ui";
import type { GrantStore } from "./grants";
import type { Principal } from "./principal";

/**
 * Store seam — threads, saved flowlets, automations, audit (Decision 1/6).
 *
 * | Deployment | Implementation |
 * |---|---|
 * | Embedded | host's choice; in-memory or SQLite in CI (demo-bank) |
 * | Cloud | Postgres in apps/cloud, all access behind this seam |
 *
 * All operations are scoped by Principal (tenant + subject); embedded
 * implementations may ignore tenantId. Timestamps are ISO 8601 strings.
 *
 * Memory (ENG-189) is deliberately NOT here yet: the architecture reserves a
 * Store concern and a context-assembly injection point, defined when that work
 * starts. Adding a `memory` member later is an additive change to this seam.
 */
export interface Store {
  threads: ThreadStore;
  flowlets: SavedFlowletStore;
  automations: AutomationStore;
  audit: AuditLog;
  /** ENG-193: standing user permission grants. Optional — additive to the
   *  frozen seam (same pattern as the reserved memory member). */
  grants?: GrantStore;
}

export interface ThreadRecord {
  id: string;
  tenantId: string;
  subject: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

/** Persisted UIMessage streams (replaces the demo's in-memory route state). */
export interface ThreadStore {
  create(scope: Principal, init?: { title?: string }): Promise<ThreadRecord>;
  get(scope: Principal, threadId: string): Promise<ThreadRecord | undefined>;
  list(scope: Principal): Promise<ThreadRecord[]>;
  appendMessages(scope: Principal, threadId: string, messages: FlowletUIMessage[]): Promise<void>;
  getMessages(scope: Principal, threadId: string): Promise<FlowletUIMessage[]>;
}

/**
 * A saved flowlet (ENG-183, Decision 6): declarative UI tree + bound data
 * query + originating prompt. Reopening re-renders the tree and re-runs the
 * query through the normal tool path (policy applies).
 */
export interface SavedFlowlet {
  id: string;
  name: string;
  pinned: boolean;
  uiTree: UINode;
  /** Re-executed via the Executor on reopen — never a raw DB query. */
  query: { toolName: string; input: unknown };
  originatingPrompt: string;
  /** Host-component name → registry version stamped at save time (ENG-186).
   *  Reopen diffs it against the live registry to surface component drift.
   *  Absent on trees with no host nodes and on pre-versioning records. */
  components?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface SavedFlowletStore {
  /** The store assigns `id` and both timestamps — callers never supply them
   *  (same authorship rule as `ThreadStore.create`). */
  save(
    scope: Principal,
    flowlet: Omit<SavedFlowlet, "id" | "createdAt" | "updatedAt">,
  ): Promise<SavedFlowlet>;
  get(scope: Principal, id: string): Promise<SavedFlowlet | undefined>;
  list(scope: Principal): Promise<SavedFlowlet[]>;
  delete(scope: Principal, id: string): Promise<void>;
}

/**
 * Automation records. The spec DSL is deliberately opaque here (`spec:
 * unknown`) — its shape is decided at ENG-188's brainstorm (Decision 5). This
 * store freezes only what every design needs: identity, lifecycle, run history.
 */
export interface AutomationRecord {
  id: string;
  name: string;
  status: "enabled" | "paused";
  /** The compiled automation spec — interpreted JSON step graph or agent goal.
   *  Opaque until ENG-188 freezes the DSL. */
  spec: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "failed";
  error?: string;
}

export interface AutomationStore {
  /** The store assigns `id` and both timestamps — callers never supply them. */
  save(
    scope: Principal,
    automation: Omit<AutomationRecord, "id" | "createdAt" | "updatedAt">,
  ): Promise<AutomationRecord>;
  get(scope: Principal, id: string): Promise<AutomationRecord | undefined>;
  list(scope: Principal): Promise<AutomationRecord[]>;
  recordRun(scope: Principal, run: AutomationRun): Promise<void>;
  listRuns(scope: Principal, automationId: string): Promise<AutomationRun[]>;
}

/**
 * Append-only audit record of every tool execution, approval, grant exchange,
 * and automation firing (Decision 6). Written from day 1; ENG-194 is UI over it.
 */
export type AuditEvent = { at: string; principal: Principal } & (
  | {
      kind: "tool_execution";
      toolName: string;
      toolCallId: string;
      mutating: boolean;
      dangerous: boolean;
      outcome: "ok" | "error";
    }
  | { kind: "approval"; toolCallId: string; decision: "approved" | "denied" }
  | { kind: "grant_exchange"; automationId: string; scopes: string[] }
  | { kind: "automation_firing"; automationId: string; runId: string }
  | { kind: "grant_created"; grantId: string; tool: string; scopePreview: string }
  | { kind: "grant_revoked"; grantId: string; tool: string }
  | { kind: "judge_escalation"; toolName: string; reason: string }
  | { kind: "consent"; consentId: string; decision: "yes" | "no" | "subset" }
);

/**
 * Read API (ENG-193 §6.2): principal-scoped, ordered by `at` descending,
 * optionally filtered by kind/since/limit (an empty `kinds` array means no
 * kind filter; `since` is inclusive). Powers receipts, the diary, and ENG-194.
 */
export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
  query(
    scope: Principal,
    filter?: { kinds?: AuditEvent["kind"][]; since?: string; limit?: number },
  ): Promise<AuditEvent[]>;
}
