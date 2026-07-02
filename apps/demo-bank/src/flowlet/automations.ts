/**
 * The demo's embedded automations world — the ENG-188 engine wired into Maple
 * with the in-memory store, the in-process scheduler, and two registered
 * tools: Maple's transaction read and the verified Slack poster. This replaces
 * the hard-wired rules-store/snitch: the "late-night delivery snitch" is now
 * pure data compiled by the chat agent (spec doc example 1).
 *
 * Module-level singleton like Maple's own store; reset re-creates it. The
 * `generation` counter lets the chat route drop agents built against a dead
 * world after a demo reset.
 */
import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel, Tool, ToolSet } from "ai";
import { z } from "zod";
import type { Principal } from "@flowlet/core";
import {
  AutomationRunner,
  InMemoryAutomationStore,
  InProcessScheduler,
  buildAutomationInstructions,
  createAgentStepRunner,
  createAutomationTools,
  createHostEventIngest,
  createSchedulerFiringHandler,
  type AutomationEngineStore,
  type AutomationRun,
  type HostEventDoc,
  type RegisteredTool,
} from "@flowlet/runtime";
import { listTransactions } from "@/server/transactions";
import type { Transaction } from "@/server/types";
import { demoPolicy } from "./policy";
import { DEMO_USER_ID } from "./principal";
import { connect as connectToolkit } from "./connections-store";
import { pacificHour, pacificTimeLabel } from "./time";
import { postToSlack, type Poster, type SlackFireResult } from "./slack";

const DEMO_MODEL = process.env.FLOWLET_DEMO_MODEL ?? "claude-sonnet-4-6";

/** The demo's Principal: one fixed tenant + the Composio-authorized subject. */
export const DEMO_SCOPE: Principal = { tenantId: "demo-bank", subject: DEMO_USER_ID };

/** The one host event the demo declares (the manifest does this later). */
export const TRANSACTION_CREATED_EVENT: HostEventDoc = {
  name: "transaction.created",
  description:
    "A Maple transaction posted (the Flowlet poller detects it on the existing transactions API)",
  payloadFields:
    "id, merchant, descriptor, category, hour (0-24 Pacific), time (label), amountDollars, direction (debit|credit), cardId?",
};

/** What the poll route returns and the client toast renders. */
export interface AutomationFireEvent {
  txnId: string;
  merchant: string;
  amountDollars: number;
  time: string;
  channel: string;
  description: string;
  slack: { ok: boolean; fallback: boolean };
}

/** The declared `transaction.created` payload contract (spec section a). */
export function toEventPayload(t: Transaction): Record<string, unknown> {
  return {
    id: t.id,
    merchant: t.merchant,
    descriptor: t.descriptor,
    category: t.category,
    hour: pacificHour(t.timestamp),
    time: pacificTimeLabel(t.timestamp),
    amountDollars: Math.round(Math.abs(t.amount)) / 100,
    direction: t.amount < 0 ? "debit" : "credit",
    ...(t.cardId !== undefined ? { cardId: t.cardId } : {}),
  };
}

export interface CreateWorldOptions {
  /** Injectable Slack poster (tests stub it; production posts for real). */
  poster?: Poster;
  /** Model for agent steps; defaults to the demo model. */
  model?: LanguageModel;
  now?: () => string;
}

export interface DemoAutomationsWorld {
  scope: Principal;
  store: AutomationEngineStore;
  runner: AutomationRunner;
  scheduler: InProcessScheduler;
  /** The chat agent's authoring toolset (create/update/list/pause/run-now…). */
  authoringTools(threadId?: string): ToolSet;
  /** The poller adapter's entry point: one new Maple transaction. */
  emitTransaction(t: Transaction): Promise<void>;
  /** Drive due schedules (the poll route ticks this; no timers needed in dev). */
  tick(): Promise<void>;
  /** Toast events accumulated since the last drain. */
  drainFireEvents(): AutomationFireEvent[];
}

function isSlackResult(value: unknown): value is SlackFireResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "ok" in value &&
    "channel" in value &&
    "text" in value
  );
}

export function createAutomationsWorld(opts: CreateWorldOptions = {}): DemoAutomationsWorld {
  const poster = opts.poster ?? postToSlack;
  const store = new InMemoryAutomationStore(opts.now ? { now: opts.now } : {});
  const fireEvents: AutomationFireEvent[] = [];

  const getTransactions: RegisteredTool = {
    descriptor: {
      name: "get_transactions",
      source: "caller",
      annotations: { readOnlyHint: true },
      hasExecute: true,
      kind: "function",
    },
    description:
      "Read the user's recent Maple transactions (merchant, amountDollars, hour, time, category, direction).",
    modelInputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max rows (default 40)." } },
    },
    inputSchema: z.object({ limit: z.number().optional() }),
    execute: async (input) => {
      try {
        const limit = typeof input["limit"] === "number" ? input["limit"] : 40;
        const { data } = listTransactions({ limit });
        return { ok: true, result: { data: data.map(toEventPayload) } };
      } catch (err) {
        return { ok: false, error: { code: "host_error", message: String(err) } };
      }
    },
  };

  const slackSendMessage: RegisteredTool = {
    descriptor: {
      name: "SLACK_SEND_MESSAGE",
      source: "composio",
      annotations: {},
      hasExecute: true,
      kind: "function",
    },
    description: "Post a message to a Slack channel (e.g. #general).",
    modelInputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name, e.g. #general" },
        text: { type: "string" },
      },
      required: ["channel", "text"],
    },
    inputSchema: z.object({ channel: z.string(), text: z.string() }),
    execute: async (input) => {
      const result = await poster(String(input["channel"]), String(input["text"]));
      // The staged fallback intentionally presents as posted (see slack.ts).
      if (result.ok || result.fallback) return { ok: true, result };
      return {
        ok: false,
        error: { code: "slack_error", message: result.error ?? "Slack post failed" },
      };
    },
  };

  const registered: Record<string, RegisteredTool> = {
    get_transactions: getTransactions,
    SLACK_SEND_MESSAGE: slackSendMessage,
  };

  const toFireEvent = (run: AutomationRun, name: string): AutomationFireEvent | undefined => {
    if (run.isTest || run.status !== "succeeded" || run.outcome !== undefined) return undefined;
    const slackStep = run.steps.find((s) => isSlackResult(s.output));
    if (!slackStep) return undefined;
    const slack = slackStep.output as SlackFireResult;
    const payload = run.trigger.payload as Partial<ReturnType<typeof toEventPayload>>;
    return {
      txnId: String(payload["id"] ?? run.trigger.eventId),
      merchant: String(payload["merchant"] ?? ""),
      amountDollars: Number(payload["amountDollars"] ?? 0),
      time: String(payload["time"] ?? ""),
      // The toast renders "#{channel}", so strip any leading # from the input.
      channel: slack.channel.replace(/^#/, ""),
      description: name,
      slack: { ok: slack.ok, fallback: slack.fallback },
    };
  };

  const runner = new AutomationRunner({
    store,
    tools: async () => registered,
    policy: demoPolicy,
    userClaims: async () => ({ id: DEMO_USER_ID, name: "Yousef" }),
    agentRunner: createAgentStepRunner({ model: opts.model ?? anthropic(DEMO_MODEL) }),
    onRunFinished: (run, automation) => {
      const event = toFireEvent(run, automation.name);
      if (event) fireEvents.push(event);
    },
    ...(opts.now ? { now: opts.now } : {}),
  });

  const scheduler = new InProcessScheduler();
  scheduler.onFire(createSchedulerFiringHandler(runner));
  const ingest = createHostEventIngest({ store, runner });

  const authoringTools = (threadId?: string): ToolSet => {
    const toolset = createAutomationTools({
      store,
      runner,
      scheduler,
      principal: DEMO_SCOPE,
      registeredTools: async () => registered,
      hostEvents: [TRANSACTION_CREATED_EVENT.name],
      ...(threadId !== undefined ? { createdFromThreadId: threadId } : {}),
    });
    // Demo rail shim: a Slack-posting automation implies Slack is in use, so
    // reflect it as connected (same behavior the old set_rule tool had).
    const create = toolset["create_automation"] as Tool;
    const originalExecute = create.execute!.bind(create);
    create.execute = async (input, options) => {
      const result = (await originalExecute(input as never, options)) as { ok?: boolean };
      if (result.ok === true && JSON.stringify(input).includes("SLACK_SEND_MESSAGE")) {
        connectToolkit("slack");
      }
      return result;
    };
    return toolset;
  };

  return {
    scope: DEMO_SCOPE,
    store,
    runner,
    scheduler,
    authoringTools,
    emitTransaction: (t) =>
      ingest(DEMO_SCOPE, TRANSACTION_CREATED_EVENT.name, {
        eventId: t.id,
        occurredAt: t.timestamp,
        payload: toEventPayload(t),
      }),
    tick: () => scheduler.tick(),
    drainFireEvents: () => fireEvents.splice(0),
  };
}

/** The system-prompt block the demo agent appends (compiler guidance). */
export function demoAutomationInstructions(): string {
  return [
    buildAutomationInstructions({ hostEvents: [TRANSACTION_CREATED_EVENT] }),
    "",
    "Tools available INSIDE automations (the automation closed world):",
    "- get_transactions: read Maple transactions (read-only).",
    '- SLACK_SEND_MESSAGE: post to a Slack channel — input { "channel", "text" }.',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Module-level singleton (like Maple's own store). Reset re-creates it.

let world: DemoAutomationsWorld = createAutomationsWorld();
let generation = 0;

export function automationsWorld(): DemoAutomationsWorld {
  return world;
}

/** Bumps on reset — the chat route keys its agent cache on this. */
export function automationsGeneration(): number {
  return generation;
}

export function resetAutomations(): void {
  world = createAutomationsWorld();
  generation += 1;
}
