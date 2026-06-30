/**
 * Server-only Flowlet agent for the Maple demo.
 *
 * Builds the real `createFlowletAgent` (anthropic model + Composio gmail/slack +
 * an allow-all demo policy) and the grounded system prompt that drives the three
 * "$87 Mystery" beats. This module pulls in `@composio/core` (Node internals) and
 * the anthropic provider, so it MUST stay server-only — import it from route
 * handlers, never from a client component.
 *
 * Per-beat in-process tools (transaction reads for Beat 1, rule-setting for
 * Beat 3) are injected by the caller via `extraTools` so this factory stays
 * focused on assembly.
 */
import { anthropic } from "@ai-sdk/anthropic";
import {
  createFlowletAgent,
  type ComposioClient,
  type ApprovalPolicy,
} from "@flowlet/agent";
import type { FlowletAgent } from "@flowlet/core";
import { prewiredComponents } from "@flowlet/components/descriptors";
import type { LanguageModel, ToolSet } from "ai";

/** Default model — fast + capable for a live, low-latency demo. Overridable. */
const DEMO_MODEL = process.env.FLOWLET_DEMO_MODEL ?? "claude-sonnet-4-6";

/**
 * Allow-all policy. The demo script shows no approval modals — the "powerful
 * action" (Beat 3's Slack post) is gated by the natural-language rule + the
 * server-side poller, not by an interactive approval. So every interactive tool
 * call (render, Gmail read, rule-set) clears automatically.
 */
const allowAllPolicy: ApprovalPolicy = {
  evaluate: () => "allow",
};

function componentCatalog(): string {
  return prewiredComponents
    .map((c) => `- ${c.name}: ${c.description}`)
    .join("\n");
}

function buildInstructions(): string {
  return [
    "You are Flowlet, an agentic layer embedded inside Maple, a consumer bank app.",
    "The user is the Maple account holder. You help them by answering questions about",
    "their money, by GENERATING bespoke UI on demand (via the render_ui tool), and by",
    "doing real work across their connected tools (Gmail, Slack via Composio).",
    "",
    "Core stance: Maple has no pre-built screen for most of what people actually want.",
    "When a question has no obvious existing screen, render a bespoke view for it.",
    "Be concise in text; let the rendered UI carry the answer.",
    "",
    "Components you can render with render_ui (pass source:'prewired', a matching name,",
    "and props as a JSON OBJECT — never a stringified JSON string — that fit the component):",
    componentCatalog(),
    "",
    "Behaviors:",
    "- Time-of-day / 'when did I spend' questions: call get_transactions, then render a",
    "  TimeOfDayClock whose points are the debit transactions (hour + amount + merchant).",
    "  Highlight the single most surprising late-night charge with highlight:true and a",
    "  short label (the merchant). Keep lateNightStart/lateNightEnd around 0–5.",
    "- 'What was that charge / look at my email' questions about a specific charge: use",
    "  the Gmail tools to find the real receipt, then render an itemized card from the",
    "  REAL line items. Surface the receipt's stated order time, not the email's",
    "  received time.",
    "- 'Tell my roommate / put me on blast when I order late-night delivery' and similar:",
    "  set a natural-language rule with the rule tool and confirm it in plain language.",
    "  Do NOT post to Slack yourself — the rule fires automatically when a matching",
    "  charge appears.",
  ].join("\n");
}

export interface CreateDemoAgentOptions {
  /** Override the model (tests pass a mock). */
  model?: LanguageModel;
  /** Inject a Composio client (tests pass a stub; production builds the real one). */
  composioClient?: ComposioClient;
  /** Per-beat in-process tools (transaction reads, rule-setting). */
  extraTools?: ToolSet;
}

export function createDemoAgent(opts: CreateDemoAgentOptions = {}): FlowletAgent {
  const model = opts.model ?? anthropic(DEMO_MODEL);
  return createFlowletAgent({
    model,
    policy: allowAllPolicy,
    instructions: buildInstructions(),
    composio: {
      config: { toolkits: ["gmail", "slack"] },
      client: opts.composioClient,
    },
    tools: opts.extraTools,
    maxSteps: 10,
  });
}
