/**
 * Live end-to-end test: a REAL Anthropic model driving the full Flowlet agent
 * loop (model -> tool dispatch -> guardrail policy -> data-ui stream), plus the
 * guardrail gating a real model's tool call.
 *
 * Skipped unless ANTHROPIC_API_KEY is set. Run with keys injected, e.g.:
 *   infisical run --projectId <id> --env dev -- pnpm -F @flowlet/agent test engine.live
 *
 * Override the model with FLOWLET_E2E_MODEL if needed.
 */
import { describe, it, expect, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { anthropic } from "@ai-sdk/anthropic";
import type { FlowletUIMessage } from "@flowlet/core";
import { createFlowletAgent, RENDER_TOOL_NAME } from "./engine";
import type { ApprovalPolicy } from "./policy";

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.FLOWLET_E2E_MODEL ?? "claude-sonnet-4-6";

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

function userTurn(text: string): FlowletUIMessage[] {
  return [{ id: "m1", role: "user", parts: [{ type: "text", text }] }];
}

const allowPolicy: ApprovalPolicy = { evaluate: () => "allow" };

describe.skipIf(!HAS_KEY)("LIVE e2e: real Anthropic model + agent loop", () => {
  it(
    "allow path: the real model calls render_ui and a data-ui node streams out",
    async () => {
      const agent = createFlowletAgent({
        model: anthropic(MODEL),
        policy: allowPolicy,
        instructions:
          "You are a UI agent. When asked to render something, you MUST call the render_ui tool.",
      });

      const parts = await collect(
        agent.run({
          messages: userTurn(
            "Render a DemoCard component with props { title: 'E2E OK' } by calling the render_ui tool now.",
          ),
          tools: {},
          principal: { userId: "e2e-user" },
          signal: new AbortController().signal,
        }),
      );

      const types = [...new Set(parts.map((p) => (p as { type: string }).type))];
      const text = parts
        .filter((p) => (p as { type: string }).type === "text-delta")
        .map((p) => (p as { delta?: string }).delta ?? "")
        .join("");
      const ui = parts.find((p) => (p as { type: string }).type === "data-ui") as
        | { data: { kind: string; name: string; props: unknown } }
        | undefined;

      // Visible proof of the live run.
      // eslint-disable-next-line no-console
      console.log("[LIVE allow] model:", MODEL, "| chunk types:", types);
      // eslint-disable-next-line no-console
      console.log("[LIVE allow] assistant text:", JSON.stringify(text));
      // eslint-disable-next-line no-console
      console.log("[LIVE allow] data-ui node:", JSON.stringify(ui?.data));

      expect(types).toContain("start");
      expect(types).toContain("finish");
      expect(ui).toBeDefined();
      expect(ui!.data.kind).toBe("component");
      expect(ui!.data.name).toBe("DemoCard");
    },
    60_000,
  );

  it(
    "guardrail path: a gated tool the real model calls pauses for approval and does NOT execute",
    async () => {
      const sendEmail = vi.fn(async () => "sent");
      const emailTool = tool({
        description: "Send an email to a recipient.",
        inputSchema: z.object({ to: z.string(), body: z.string() }),
        execute: sendEmail,
      });

      // Gate send_email to "approve"; everything else allowed.
      const policy: ApprovalPolicy = {
        evaluate: (ctx) => (ctx.toolName === "send_email" ? "approve" : "allow"),
      };

      const agent = createFlowletAgent({
        model: anthropic(MODEL),
        policy,
        tools: { send_email: emailTool },
        instructions:
          "You are an assistant with a send_email tool. When asked to email someone, you MUST call send_email.",
      });

      const parts = await collect(
        agent.run({
          messages: userTurn(
            "Email test@example.com with the body 'hello from flowlet' by calling send_email now.",
          ),
          tools: {},
          principal: { userId: "e2e-user" },
          signal: new AbortController().signal,
        }),
      );

      const types = [...new Set(parts.map((p) => (p as { type: string }).type))];
      const approvalChunk = parts.find((p) =>
        (p as { type: string }).type.toLowerCase().includes("approval"),
      );

      // eslint-disable-next-line no-console
      console.log("[LIVE gate] model:", MODEL, "| chunk types:", types);
      // eslint-disable-next-line no-console
      console.log("[LIVE gate] approval chunk type:", (approvalChunk as { type?: string })?.type);
      // eslint-disable-next-line no-console
      console.log("[LIVE gate] send_email executed?:", sendEmail.mock.calls.length > 0);

      // The model called the gated tool, the guardrail paused for approval, and
      // the real tool never ran (no auto-resubmit/approval was provided here).
      expect(approvalChunk).toBeDefined();
      expect(sendEmail).not.toHaveBeenCalled();
    },
    60_000,
  );
});
