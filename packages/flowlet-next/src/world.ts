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
 */
import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel, ToolSet } from "ai";
import type { Principal } from "@flowlet/core";
import {
  AutomationRunner,
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
  authoringTools(threadId?: string): ToolSet;
  /** Drive due schedules — the client pings POST /tick (no server timers). */
  tick(): Promise<void>;
}

export function createAutomationsWorld(config: CreateWorldConfig): FlowletAutomationsWorld {
  const registered = config.tools ?? {};
  const store = new InMemoryAutomationStore({});
  const runner = new AutomationRunner({
    store,
    tools: async () => registered,
    policy: config.policy,
    userClaims: async () => ({ id: config.scope.subject }),
    agentRunner: createAgentStepRunner({ model: config.model }),
  });
  const scheduler = new InProcessScheduler();
  scheduler.onFire(createSchedulerFiringHandler(runner));

  return {
    store,
    scheduler,
    runner,
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

/** Default model factory shared by the agent and agent-step runner. */
export function defaultModel(env: Record<string, string | undefined> = process.env): LanguageModel {
  return anthropic(env["FLOWLET_MODEL"] ?? "claude-sonnet-4-6");
}
