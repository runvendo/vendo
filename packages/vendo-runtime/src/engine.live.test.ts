/**
 * Live end-to-end test: a REAL Anthropic model driving the full Vendo agent
 * loop (model -> tool dispatch -> guardrail policy -> data-ui stream), plus the
 * guardrail gating a real model's tool call.
 *
 * Skipped unless ANTHROPIC_API_KEY is set. Run with keys in your environment, e.g.:
 *   ANTHROPIC_API_KEY=sk-... pnpm -F @vendoai/runtime test engine.live
 *
 * Override the model with VENDO_E2E_MODEL if needed.
 */
import { describe, it, expect, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { anthropic } from "@ai-sdk/anthropic";
import type { VendoUIMessage } from "@vendoai/core";
import { createVendoAgent, RENDER_VIEW_TOOL_NAME } from "./engine";
import { createComposioClient } from "./composio";
import type { ApprovalPolicy } from "./policy";

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const HAS_BOTH = HAS_KEY && !!process.env.COMPOSIO_API_KEY;
const MODEL = process.env.VENDO_E2E_MODEL ?? "claude-sonnet-4-6";

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

function userTurn(text: string): VendoUIMessage[] {
  return [{ id: "m1", role: "user", parts: [{ type: "text", text }] }];
}

const allowPolicy: ApprovalPolicy = { evaluate: () => "allow" };

describe.skipIf(!HAS_KEY)("LIVE e2e: real Anthropic model + agent loop", () => {
  it(
    "allow path: the real model calls render_view and a data-ui node streams out",
    async () => {
      const agent = createVendoAgent({
        model: anthropic(MODEL),
        policy: allowPolicy,
        instructions:
          `You are a UI agent. When asked to render something, you MUST call the ${RENDER_VIEW_TOOL_NAME} tool.`,
      });

      const parts = await collect(
        agent.run({
          messages: userTurn(
            `Render a view containing a single Text node showing "E2E OK" by calling the ${RENDER_VIEW_TOOL_NAME} tool now.`,
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
        | { data: { kind: string; payload: unknown } }
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
      expect(ui!.data.kind).toBe("generated");
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

      const agent = createVendoAgent({
        model: anthropic(MODEL),
        policy,
        tools: { send_email: emailTool },
        instructions:
          "You are an assistant with a send_email tool. When asked to email someone, you MUST call send_email.",
      });

      const parts = await collect(
        agent.run({
          messages: userTurn(
            "Email test@example.com with the body 'hello from vendo' by calling send_email now.",
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

describe.skipIf(!HAS_BOTH)("LIVE e2e: real model + real Composio tools", () => {
  it(
    "ingests a real GitHub tool, the real model calls it, and the loop dispatches it to Composio",
    async () => {
      // Discover a real GitHub tool slug from the live Composio API.
      const client = createComposioClient({ toolkits: ["github"] });
      const ingested = await client.fetchTools("e2e-user", { toolkits: ["github"] });
      const names = Object.keys(ingested);
      // eslint-disable-next-line no-console
      console.log("[LIVE composio] github tools fetched:", names.length, "| sample:", names.slice(0, 6));
      expect(names.length).toBeGreaterThan(0);

      // Prefer a no-argument read tool (authenticated user) for a clean call.
      const target = names.find((n) => /AUTHENTICATED_USER/i.test(n)) ?? names[0];

      // Build the agent with JUST that one Composio tool (tight + cheap), allow policy.
      const agent = createVendoAgent({
        model: anthropic(MODEL),
        policy: allowPolicy,
        composio: { config: { tools: [target] } },
        instructions: "You have GitHub tools. When asked, call the named tool.",
      });

      const parts = await collect(
        agent.run({
          messages: userTurn(
            `Call the ${target} tool now to fetch data. If it takes no arguments, pass an empty object.`,
          ),
          tools: {},
          principal: { userId: "e2e-user" },
          signal: new AbortController().signal,
        }),
      );

      const types = [...new Set(parts.map((p) => (p as { type: string }).type))];
      const blob = JSON.stringify(parts);
      const toolResult = parts.find((p) =>
        /tool-output|tool-result|tool-error/.test((p as { type: string }).type),
      );

      // eslint-disable-next-line no-console
      console.log("[LIVE composio] target tool:", target);
      // eslint-disable-next-line no-console
      console.log("[LIVE composio] chunk types:", types);
      // eslint-disable-next-line no-console
      console.log("[LIVE composio] tool result/error chunk:", JSON.stringify(toolResult)?.slice(0, 400));

      // The real model invoked the real Composio tool (it appears in the stream),
      // proving Composio tools are live in the agent loop. Execution then hits the
      // real Composio API (returns data if the user has a connected GitHub account,
      // or a Composio auth error if not — either way the dispatch path is exercised).
      expect(blob).toContain(target);
    },
    90_000,
  );
});
