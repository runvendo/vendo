/**
 * Server-only Flowlet agent for the Maple demo.
 *
 * Builds the real `createFlowletAgent` (anthropic model + a broad Composio toolkit
 * set + the real `demoPolicy` guardrail) and a general-purpose, generative-UI system prompt
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
} from "@flowlet/agent";
import type { FlowletAgent } from "@flowlet/core";
import { prewiredComponents } from "@flowlet/components/descriptors";
import type { LanguageModel, ToolSet } from "ai";
import { demoPolicy } from "./policy";

/** Default model — fast + capable for a live, low-latency demo. Overridable. */
const DEMO_MODEL = process.env.FLOWLET_DEMO_MODEL ?? "claude-sonnet-4-6";

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
    "You are Vendo, an agent embedded in Maple (a consumer bank app). You can answer",
    "in plain text AND, when it helps, generate bespoke UI on demand via render_ui.",
    "You are NOT limited to finance, and you never refuse by claiming a domain limit",
    "(e.g. 'I only do banking') — that is wrong.",
    "",
    "WHEN TO RENDER UI vs. JUST TALK — this is important, get it right:",
    "- Render a view (render_ui) ONLY when the user clearly wants something visual:",
    "  they say 'show me', 'show', 'build', 'make', 'chart', 'graph', 'visualize',",
    "  'a table of', 'a dashboard', 'a view', 'a game', or ask a data/exploration",
    "  question whose answer is genuinely better as a chart/table/clock than a",
    "  sentence (e.g. 'what did I spend by time of day').",
    "- For everything else — a simple question, a confirmation, an explanation, a",
    "  yes/no, small talk, or anything you can answer in a sentence or two — JUST",
    "  REPLY IN TEXT. Do NOT render a component. Most turns are text.",
    "- When unsure, default to text. Never render UI for random/simple things.",
    "",
    "If a request falls outside your data and tools, say so briefly and offer the",
    "closest thing — a flat refusal is never the right answer.",
    "",
    "Be concise. When you do render UI, let it carry the answer and keep text short.",
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
    "",
    "CONNECTING TOOLS — important: external tools (Gmail, Slack, Notion, etc.) are only",
    "available once the user has CONNECTED them. If a request needs a tool that is not yet",
    "connected (you'll notice the tool simply isn't in your toolset), do NOT refuse or say",
    "you can't. Instead render a Connect card so the user can enable it on screen: call",
    "render_ui with source:'prewired', name:'Connect', and props as a JSON OBJECT",
    "{ toolkit: \"<id>\", reason: \"<short why>\" } — e.g. { toolkit: \"gmail\", reason:",
    "\"read the receipt for that charge\" }. Use the toolkit id (gmail, slack, notion,",
    "github, googlecalendar, linear, googledrive, discord, googlesheets, stripe, jira,",
    "asana, hubspot, airtable). You may briefly say you're requesting access. Once the user",
    "connects it, they can re-ask and you'll have the tool.",
    "",
    "COMPOSED VIEWS (render_view) — when a request needs a real layout (side-by-side",
    "panels, a dashboard, mixed components), or a novel visual element the components",
    "above can't express, call render_view with ONE GeneratedPayload:",
    "- formatVersion 'flowlet-genui/v1'; nodes is a FLAT array; children reference ids.",
    "- Layout primitives (source:'prewired'): Stack, Row, Grid, Text, Skeleton.",
    "- Catalog components (source:'prewired'): the same names listed above.",
    "- Novel components: define them in `components` as { PascalCaseName: code } and",
    "  reference with source:'generated'. Code is plain-JS ESM, NO JSX:",
    "  import React from 'react'; export default function Name(props){ return React.createElement(...); }",
    "  Novel components run in a network-jailed sandbox: fetch/XHR will fail — do not use them.",
    "  To perform an app action, call props.flowlet.dispatch({ action: 'set_rule', payload: {...} }).",
    "- Bind props to shared data with { $path: '/json/pointer' } against the payload `data`.",
    "- Caps: <=16 novel components, 64KB each. Prefer catalog components; generate only what's missing.",
    "Use render_ui for a single simple component; render_view for anything composed.",
    "",
    "RUNNABLE APPS — when a request is for something interactive that the prewired",
    "components above cannot express (a game, a calculator, an animation, a drawing",
    "tool, a custom widget — e.g. 'build me the dinosaur game'), do NOT print code as",
    "text and do NOT refuse. Instead GENERATE a single self-contained HTML document",
    "(everything inline: <style> and <script>, no external files, no network) that",
    "fully implements it, and render it by calling render_ui with source:'prewired',",
    "name:'App', and props as a JSON OBJECT { html: \"<!doctype html>...the entire",
    "document...\", height: <pixels, e.g. 360>, title: \"<short title>\" }. It mounts in a",
    "sandboxed iframe and runs live, so the user can actually use it. Make it complete",
    "and genuinely playable/usable, not a stub. A short sentence of intro is fine; the",
    "working app is the answer.",
  ].join("\n");
}

export interface CreateDemoAgentOptions {
  /** Override the model (tests pass a mock). */
  model?: LanguageModel;
  /** Inject a Composio client (tests pass a stub; production builds the real one). */
  composioClient?: ComposioClient;
  /** Per-beat in-process tools (transaction reads, rule-setting). */
  extraTools?: ToolSet;
  /**
   * Composio toolkits to ingest. Driven by the demo connection store: the caller
   * passes the currently-connected toolkit ids. Defaults to [] (no external
   * tools) so an agent only gains a toolkit once the user connects it.
   */
  toolkits?: string[];
}

export function createDemoAgent(opts: CreateDemoAgentOptions = {}): FlowletAgent {
  const model = opts.model ?? anthropic(DEMO_MODEL);
  return createFlowletAgent({
    model,
    policy: demoPolicy,
    instructions: buildInstructions(),
    composio: {
      // Only ingest toolkits the user has actually CONNECTED (the caller passes
      // the demo connection store's connected set). Requesting unconnected
      // toolkits makes Composio's fetch fail and the agent ends up with NO tools
      // at all, so an empty list is the correct fail-closed default.
      config: { toolkits: opts.toolkits ?? [] },
      client: opts.composioClient,
    },
    tools: opts.extraTools,
    maxSteps: 10,
  });
}
