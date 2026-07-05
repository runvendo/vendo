/**
 * The handler's embedded automations world: the ENG-188 engine assembled with
 * an engine store (in-memory by default, `DrizzleAutomationStore` when the
 * handler resolves durable storage — see `storage.ts`) and an in-process
 * scheduler (the embedded seam impls), the handler's own policy, and
 * whatever server-executed tools the host registers through
 * `automations.tools`.
 *
 * Zero-config note: host-API tools from `.flowlet/tools.json` are CLIENT-
 * executed (they ride the user's browser session) and therefore cannot run
 * unattended — so they are deliberately NOT registered here. An automation
 * step can only call tools the host registered server-side.
 *
 * SINGLE-TENANT: the world is created once per handler with a fixed scope
 * (`DEFAULT_PRINCIPAL`), regardless of whether its store is in-memory or
 * durable. A `principal` resolver gates who may reach the endpoints, but does
 * NOT partition automations per user — every caller shares one automation
 * store scope. Multi-tenant installs must front their own per-user
 * store/world. (Documented in docs/quickstart.md → Deploying.)
 */
import type { LanguageModel, ToolSet } from "ai";
import type { AuditLog, Principal } from "@flowlet/core";
import {
  AutomationRunner,
  InAppChannels,
  InMemoryAutomationStore,
  InProcessScheduler,
  createAgentStepRunner,
  createAutomationTools,
  createSchedulerFiringHandler,
  type ApprovalPolicy,
  type AutomationEngineStore,
  type RegisteredTool,
} from "@flowlet/runtime";

export interface CreateWorldConfig {
  policy: ApprovalPolicy;
  model: LanguageModel;
  /** Server-executed tools automation steps may reference. */
  tools?: Record<string, RegisteredTool>;
  /** The engine store scope. One embedded tenant; subject = default user. */
  scope: Principal;
  /** ENG-193 §4.6/§6.2 — when present, a parked-action resolution appends the
   *  SAME "consent" audit event kind chat approvals already use. Absent in
   *  tests that don't wire an audit log; `scope` is already Principal-shaped
   *  here, so the runner's default identity `auditPrincipal` is correct. */
  audit?: AuditLog;
  /**
   * The engine store. Default: a fresh `InMemoryAutomationStore` (nothing
   * survives a restart). The handler hands in a `DrizzleAutomationStore` when
   * durable storage is configured (see `storage.ts`).
   */
  store?: AutomationEngineStore;
}

export interface FlowletAutomationsWorld {
  store: AutomationEngineStore;
  scheduler: InProcessScheduler;
  runner: AutomationRunner;
  /** In-app deliveries (FlowletToasts): the client polls these via the
   *  handler's /deliveries route. */
  channels: InAppChannels;
  authoringTools(threadId?: string): ToolSet;
  /** Drive due schedules — the client pings POST /tick (no server timers). */
  tick(): Promise<void>;
  /**
   * The world's OWN fixed scope (= this config's `scope`), exposed so
   * callers that must read/write the world's store agree with where
   * `authoringTools`/the runner actually park and create rows — same
   * SINGLE-TENANT simplification this module's docstring already declares.
   * Review follow-up (parked-actions.ts): the per-request principal a
   * multi-user mount resolves is NOT this scope, and parked rows always live
   * under THIS one — routes must key off `world.scope`, never re-derive a
   * scope from whatever principal the request happened to resolve.
   */
  scope: Principal;
}

export function createAutomationsWorld(config: CreateWorldConfig): FlowletAutomationsWorld {
  const registered = config.tools ?? {};
  const store = config.store ?? new InMemoryAutomationStore({});
  const channels = new InAppChannels();
  const runner = new AutomationRunner({
    store,
    tools: async () => registered,
    policy: config.policy,
    userClaims: async () => ({ id: config.scope.subject }),
    agentRunner: createAgentStepRunner({ model: config.model }),
    ...(config.audit ? { audit: config.audit } : {}),
    channels,
  });
  const scheduler = new InProcessScheduler();
  scheduler.onFire(createSchedulerFiringHandler(runner));

  return {
    store,
    scheduler,
    runner,
    scope: config.scope,
    channels,
    authoringTools: (threadId?: string) =>
      createAutomationTools({
        store,
        runner,
        scheduler,
        principal: config.scope,
        registeredTools: async () => registered,
        hostEvents: [],
        ...(threadId !== undefined ? { createdFromThreadId: threadId } : {}),
      }),
    tick: () => scheduler.tick(),
  };
}
