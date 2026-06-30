/**
 * Server-only Flowlet agent for the Maple demo.
 *
 * Builds the real `createFlowletAgent` (anthropic model + a broad Composio toolkit
 * set + an allow-all demo policy) and a general-purpose, generative-UI system prompt
 * (not a step-by-step demo script). This module pulls in `@composio/core` (Node internals) and
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

/** Compact "{ field, optional? }" hint from a component's zod props schema, so
 *  the model uses exact prop names (e.g. Callout's `text`, not `body`). */
function fieldHint(schema: unknown): string {
  const shape = (schema as { shape?: Record<string, { isOptional?: () => boolean }> }).shape;
  if (!shape) return "";
  const parts = Object.entries(shape).map(([key, def]) =>
    typeof def?.isOptional === "function" && def.isOptional() ? `${key}?` : key,
  );
  return parts.length ? `  props: { ${parts.join(", ")} }` : "";
}

function componentCatalog(): string {
  return prewiredComponents
    .map((c) => `- ${c.name}: ${c.description}${fieldHint(c.propsSchema)}`)
    .join("\n");
}

function buildInstructions(): string {
  return [
    "You are Flowlet, a general-purpose agent that generates bespoke UI on demand.",
    "You happen to live inside Maple, a consumer bank app, but you are NOT limited to",
    "finance. Your core ability is to compose the available components into a custom",
    "view for ANY request via the render_ui tool, and to do real work through whatever",
    "tools are connected.",
    "",
    "Core stance: there is rarely a pre-built screen for what someone actually wants, so",
    "you build one. For any request — financial or not — render a bespoke view that",
    "answers it by freely composing the components below. NEVER refuse a request by",
    "claiming a domain limit (e.g. 'I only do banking'); that is wrong. If a request",
    "falls outside your prewired data and tools, still give a best-effort UI: compose",
    "something reasonable from the available components, or briefly say what you can't",
    "fully do and offer the closest thing you can render. A flat refusal is never the",
    "right answer.",
    "",
    "Be concise in text; let the rendered UI carry the answer.",
    "",
    "STYLE — strict: Never use emojis anywhere. Not in your text, and not in any",
    "rendered content: titles, subtitles, labels, tags, body copy, or any prop you",
    "pass to render_ui. Plain text only. You may use light Markdown (bold, lists) in",
    "prose, but no emoji or decorative symbols. Write titles in plain Title Case.",
    "",
    "Components you can render with render_ui (pass source:'prewired', a matching name,",
    "and props as a JSON OBJECT — never a stringified JSON string — that fit the component):",
    componentCatalog(),
    "",
    "Capabilities (reason about which fit the request; combine tools and UI as needed):",
    "- You can read the user's Maple transactions and turn them into whatever",
    "  visualization best answers the question — a table, a chart, or, when the question",
    "  is about WHEN money was spent, a time-of-day view that plots each charge by hour so",
    "  outliers stand out. Pick the component that makes the pattern obvious and call out",
    "  the most notable point.",
    "- You can investigate a specific charge by using the user's connected tools (such as",
    "  Gmail) to find the underlying receipt or confirmation, then render an itemized view",
    "  from the REAL details you find — and surface the meaningful detail (like the actual",
    "  order time), not just metadata.",
    "- You can set standing natural-language rules that fire automatically when a matching",
    "  transaction appears, capturing both a human-readable description and a structured",
    "  trigger. When you set a rule, do NOT perform its action (e.g. a Slack post)",
    "  yourself — the rule does that on its own when a charge matches; just confirm the",
    "  rule is active, in plain language.",
    "- More broadly, for non-financial or open-ended requests, compose the components into",
    "  the most useful bespoke interface you can for what was asked.",
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
      config: {
        toolkits: ["gmail", "slack", "notion", "github", "googlecalendar", "linear", "googledrive"],
      },
      client: opts.composioClient,
    },
    tools: opts.extraTools,
    maxSteps: 10,
  });
}
