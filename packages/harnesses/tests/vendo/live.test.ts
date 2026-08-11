/**
 * The BYO-model provider matrix, live.
 *
 * It was `packages/agent/src/live.test.ts` and it drove `createAgent`. The loop
 * moved here, so the live proof moves with it: the same three-leg journey —
 * a parked approval that runs exactly once, a blocked call that never runs, and
 * a tree that reaches the screen — now through the runtime + `vendo()`, against
 * the same three providers, gated on the same env vars. A provider that cannot
 * hold this journey is a provider Vendo cannot ship on.
 *
 * Two shapes differ from the deleted file, and both are the harness path's own,
 * not a weakened assertion:
 *   - the approval is answered IN-STREAM (the turn blocks on the tap) instead of
 *     by a client re-post, so the tap arrives through the guard here;
 *   - a blocked outcome is a `tool-output-denied` part rather than an ok-shaped
 *     part carrying `{status:"blocked"}` — the runtime's refusal affordance.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import type { ThreadId, ToolDescriptor } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { vendo } from "../../src/vendo/vendo.js";
import { createHarnessRuntime } from "../../src/runtime.js";
import {
  boundRegistry,
  ctx,
  readSse,
  seats,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  userMessage,
} from "../../src/test-doubles.test-util.js";

interface LiveProvider {
  name: string;
  enabled: boolean;
  model(): LanguageModel;
}

const descriptor = (name: string, risk: "read" | "write"): ToolDescriptor => ({
  name,
  description: `${name} live provider-matrix fixture`,
  inputSchema: { type: "object" },
  risk,
});

const SYSTEM = [
  "This is a deterministic conformance journey.",
  'For a message beginning APPROVAL, call send_echo exactly once with {"value":"live"}.',
  'For a message beginning BLOCKED, call blocked_write exactly once with {"value":"unsafe"}.',
  'For a message beginning VIEW, call vendo_apps_open exactly once with {"appId":"app_1"}.',
  "After each tool result, answer briefly in text and do not call another tool.",
].join(" ");

/** One leg: a real model, the real runtime, the real guard-bound registry. */
async function leg(model: LanguageModel, thread: string, prompt: string) {
  const guard = testGuard({ send_echo: "ask", blocked_write: "block", vendo_apps_open: "run" });
  // The tap, delivered the moment the card is raised. On this path the turn
  // BLOCKS on the approval rather than ending at it, so a client re-post cannot
  // be what answers it; this stands for the human who taps Approve.
  const realCheck = guard.check.bind(guard);
  guard.previewCheck = async (call, toolDescriptor, runCtx) => {
    const decision = await realCheck(call, toolDescriptor, runCtx);
    if (decision.action === "ask") guard.decide(decision.approval.id, true);
    return decision;
  };
  const registry = boundRegistry({
    send_echo: {
      descriptor: descriptor("send_echo", "write"),
      execute: (input) => ({ echoed: (input as { value?: string }).value ?? "live" }),
    },
    blocked_write: {
      descriptor: descriptor("blocked_write", "write"),
      execute: () => ({ shouldNotRun: true }),
    },
    vendo_apps_open: {
      descriptor: descriptor("vendo_apps_open", "read"),
      execute: () => ({
        kind: "tree",
        appId: "app_1",
        payload: {
          formatVersion: "vendo-genui/v2",
          root: "r",
          nodes: [{ id: "r", component: "Text", props: { text: "Live provider" } }],
        },
      }),
    },
  }, guard);
  const runtime = createHarnessRuntime({
    tools: registry,
    guard,
    skills: testSkills(),
    transcript: testTranscript(),
  });
  const parts = await readSse(await runtime.run({
    harness: vendo(),
    threadId: thread as ThreadId,
    messages: [userMessage(`user_${thread}`, prompt)],
    ctx: ctx(),
    workspace: testWorkspace(),
    models: seats(model),
    system: SYSTEM,
    interactive: true,
  }));
  return { parts, registry };
}

async function runProviderJourney(model: LanguageModel): Promise<void> {
  const approval = await leg(model, "thr_live_approval", "APPROVAL: run the required tool now.");
  // The card was raised before the turn blocked — the affordance a surface taps.
  expect(approval.parts.some((part) => part.type === "tool-approval-request")).toBe(true);
  expect(approval.parts.find((part) => part.type === "tool-output-available"))
    .toMatchObject({ output: { echoed: "live" } });
  expect(approval.registry.invocations.send_echo).toBe(1);

  const blocked = await leg(model, "thr_live_blocked", "BLOCKED: run the required tool now.");
  expect(blocked.parts.some((part) => part.type === "tool-output-denied")).toBe(true);
  expect(blocked.registry.invocations.blocked_write ?? 0).toBe(0);

  const view = await leg(model, "thr_live_view", "VIEW: run the required tool now.");
  expect(view.parts.find((part) => part.type === "data-vendo-view"))
    .toMatchObject({ data: { appId: "app_1", payload: { formatVersion: "vendo-genui/v2" } } });
  expect(view.registry.invocations.vendo_apps_open).toBe(1);
}

const liveProviders: LiveProvider[] = [
  {
    name: "Anthropic",
    enabled: Boolean(process.env.ANTHROPIC_API_KEY),
    model: () => createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(
      process.env.ANTHROPIC_TEST_MODEL ?? "claude-haiku-4-5-20251001",
    ),
  },
  {
    name: "OpenAI",
    enabled: Boolean(process.env.OPENAI_API_KEY),
    model: () => createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(
      process.env.OPENAI_TEST_MODEL ?? "gpt-4.1-mini",
    ),
  },
  {
    name: "OpenAI-compatible proxy",
    enabled: Boolean(process.env.VENDO_TEST_PROXY_URL && process.env.VENDO_TEST_PROXY_KEY),
    model: () => createOpenAICompatible({
      name: "vendo-test-proxy",
      baseURL: process.env.VENDO_TEST_PROXY_URL!,
      apiKey: process.env.VENDO_TEST_PROXY_KEY,
    })(process.env.VENDO_TEST_PROXY_MODEL ?? "gpt-4.1-mini"),
  },
];

for (const provider of liveProviders) {
  describe.skipIf(!provider.enabled)(`provider matrix live — ${provider.name}`, () => {
    it("runs the shared approval, blocked-outcome, and view-part journey", async () => {
      await runProviderJourney(provider.model());
    }, 180_000);
  });
}
