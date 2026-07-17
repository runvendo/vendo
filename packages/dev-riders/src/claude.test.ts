import { describe, expect, it } from "vitest";
import { ClaudeSessionRider } from "./claude.js";
import type { RiderSessionStart } from "./types.js";

/** A fake Agent SDK capturing query options and scripting a streaming session. */
function fakeSdk() {
  const captured: { options?: Record<string, unknown> } = {};
  const sdk = {
    query(params: { prompt: AsyncIterable<unknown> | string; options: Record<string, unknown> }) {
      captured.options = params.options;
      const prompt = params.prompt as AsyncIterable<Record<string, unknown>>;
      async function* messages(): AsyncGenerator<Record<string, unknown>> {
        // Streaming-input contract: nothing is emitted until a user message
        // arrives (the rider must never block on init).
        for await (const userMessage of prompt) {
          const text = (userMessage as { message: { content: Array<{ text: string }> } }).message.content[0]!.text;
          yield { type: "system", subtype: "init", model: "fake-opus" };
          yield {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "echo: " } },
          };
          yield {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text } },
          };
          yield { type: "result", subtype: "success", result: `echo: ${text}` };
        }
      }
      const iterable = messages() as AsyncGenerator<Record<string, unknown>> & { interrupt(): Promise<void> };
      iterable.interrupt = async () => {
        await iterable.return(undefined as never);
      };
      return iterable;
    },
  };
  return { sdk, captured };
}

function startOptions(overrides: Partial<RiderSessionStart> = {}): RiderSessionStart {
  return {
    system: "You are the test agent.",
    tools: [],
    onToolCall: async () => ({ text: "", ok: true }),
    ...overrides,
  };
}

describe("ClaudeSessionRider with an injected SDK", () => {
  it("runs sequential turns over one persistent session", async () => {
    const { sdk } = fakeSdk();
    const rider = new ClaudeSessionRider({ loadSdk: async () => sdk });
    try {
      await rider.start(startOptions());
      const deltas: string[] = [];
      const first = await rider.runTurn("one", (delta) => deltas.push(delta));
      expect(first.text).toBe("echo: one");
      expect(deltas).toEqual(["echo: ", "one"]);
      expect(rider.model).toBe("fake-opus");
      const second = await rider.runTurn("two", () => {});
      expect(second.text).toBe("echo: two");
    } finally {
      await rider.dispose();
    }
  });

  it("locks the ridden session down: no settings, no built-ins, vendo-only tools", async () => {
    const { sdk, captured } = fakeSdk();
    const rider = new ClaudeSessionRider({ loadSdk: async () => sdk });
    try {
      await rider.start(startOptions());
      const options = captured.options!;
      // MANDATORY: never inherit the developer's personal Claude Code config/hooks.
      expect(options["settingSources"]).toEqual([]);
      // No built-in harness tools at all, plus the deny-list as defense in depth.
      expect(options["tools"]).toEqual([]);
      expect(options["disallowedTools"]).toContain("Bash");
      expect(options["systemPrompt"]).toBe("You are the test agent.");
      // The subprocess must ride the login, not an env key.
      expect((options["env"] as Record<string, unknown>)["ANTHROPIC_API_KEY"]).toBeUndefined();
      // Deny-all-non-vendo permission callback.
      const canUseTool = options["canUseTool"] as (name: string, input: unknown) => Promise<{ behavior: string }>;
      expect((await canUseTool("mcp__vendo__vendo_echo", {})).behavior).toBe("allow");
      expect((await canUseTool("Bash", {})).behavior).toBe("deny");
      expect((await canUseTool("mcp__other__thing", {})).behavior).toBe("deny");
    } finally {
      await rider.dispose();
    }
  });

  it("bridges host tools through an injected MCP instance factory", async () => {
    const { sdk, captured } = fakeSdk();
    let received: RiderSessionStart | null = null;
    const rider = new ClaudeSessionRider({
      loadSdk: async () => sdk,
      createMcpInstance: async (start) => {
        received = start;
        return { fake: "mcp" };
      },
    });
    try {
      await rider.start(startOptions({
        tools: [{ name: "vendo_echo", description: "Echo.", inputSchema: { type: "object" } }],
      }));
      expect(received).not.toBeNull();
      const servers = captured.options!["mcpServers"] as Record<string, Record<string, unknown>>;
      expect(servers["vendo"]).toMatchObject({ type: "sdk", name: "vendo", instance: { fake: "mcp" } });
    } finally {
      await rider.dispose();
    }
  });

  it("reports a missing host SDK install with the exact fix", async () => {
    const rider = new ClaudeSessionRider({ root: "/tmp" });
    await expect(rider.start(startOptions())).rejects.toThrow(/npm install -D @anthropic-ai\/claude-agent-sdk/);
  });
});
