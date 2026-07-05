/**
 * The handler's embedded automations world: the ENG-188 engine assembled with
 * the in-memory store and in-process scheduler (the embedded seam impls), the
 * handler's own policy, and whatever server-executed tools the host registers
 * through `automations.tools`.
 *
 * Zero-config note: host-API tools from `.flowlet/tools.json` are CLIENT-
 * executed (they ride the user's browser session) and therefore cannot run
 * unattended — so they are deliberately NOT registered here. An automation
 * step can only call tools the host registered server-side.
 *
 * SINGLE-TENANT: the world is created once per handler with a fixed scope
 * (`DEFAULT_PRINCIPAL`), and its store lives in memory. A `principal` resolver
 * gates who may reach the endpoints, but does NOT partition automations per
 * user — every caller shares one automation store. Multi-tenant installs must
 * front their own per-user store/world. (Documented in docs/quickstart.md →
 * Deploying.)
 */
import type { LanguageModel, ToolSet } from "ai";
import type { Principal } from "@flowlet/core";
import {
  AutomationRunner,
  InAppChannels,
  InMemoryAutomationStore,
  InProcessScheduler,
  createAgentStepRunner,
  createAutomationTools,
  createSchedulerFiringHandler,
  type ApprovalPolicy,
  type RegisteredTool,
} from "@flowlet/runtime";

export interface CreateWorldConfig {
  policy: ApprovalPolicy;
  model: LanguageModel;
  /** Server-executed tools automation steps may reference. */
  tools?: Record<string, RegisteredTool>;
  /** The engine store scope. One embedded tenant; subject = default user. */
  scope: Principal;
}

export interface FlowletAutomationsWorld {
  store: InMemoryAutomationStore;
  scheduler: InProcessScheduler;
  runner: AutomationRunner;
  /** In-app deliveries (FlowletToasts): the client polls these via the
   *  handler's /deliveries route. */
  channels: InAppChannels;
  authoringTools(threadId?: string): ToolSet;
  /** Drive due schedules — the client pings POST /tick (no server timers). */
  tick(): Promise<void>;
}

export function createAutomationsWorld(config: CreateWorldConfig): FlowletAutomationsWorld {
  const registered = config.tools ?? {};
  const store = new InMemoryAutomationStore({});
  const channels = new InAppChannels();
  const runner = new AutomationRunner({
    store,
    tools: async () => registered,
    policy: config.policy,
    userClaims: async () => ({ id: config.scope.subject }),
    agentRunner: createAgentStepRunner({ model: config.model }),
    channels,
  });
  const scheduler = new InProcessScheduler();
  scheduler.onFire(createSchedulerFiringHandler(runner));

  return {
    store,
    scheduler,
    runner,
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
