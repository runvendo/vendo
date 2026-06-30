import { describe, it, expect, vi } from "vitest";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import {
  ingestComposioTools,
  createComposioClient,
  type ComposioClient,
  type ComposioConfig,
} from "./composio";
import type { FlowletPrincipal } from "./principal";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const principal: FlowletPrincipal = { userId: "user_123", roles: ["dev"] };

/** A 2-tool ai-SDK ToolSet, shaped like what Composio's Vercel provider returns. */
function twoToolSet(): ToolSet {
  return {
    GMAIL_SEND_EMAIL: tool({
      description: "Send an email",
      inputSchema: z.object({ to: z.string() }),
      execute: async () => "sent",
    }),
    SLACK_POST_MESSAGE: tool({
      description: "Post a Slack message",
      inputSchema: z.object({ channel: z.string() }),
      execute: async () => "posted",
    }),
  };
}

/**
 * A fake `ComposioClient` that records the args it was called with and returns
 * a fixed toolset. The whole test suite is OFFLINE — no network.
 */
function fakeClient(toolset: ToolSet) {
  const calls: Array<{ userId: string; allowlist: { toolkits?: string[]; tools?: string[] } }> = [];
  const fetchTools = vi.fn(
    async (
      userId: string,
      allowlist: { toolkits?: string[]; tools?: string[] },
    ): Promise<ToolSet> => {
      calls.push({ userId, allowlist });
      return toolset;
    },
  );
  const client: ComposioClient = { fetchTools };
  return { client, fetchTools, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingestComposioTools", () => {
  it("returns the fetched toolset and a composio descriptor per tool", async () => {
    const toolset = twoToolSet();
    const { client } = fakeClient(toolset);
    const config: ComposioConfig = { toolkits: ["gmail", "slack"] };

    const result = await ingestComposioTools({ principal, config, client });

    expect(Object.keys(result.toolset)).toEqual([
      "GMAIL_SEND_EMAIL",
      "SLACK_POST_MESSAGE",
    ]);
    expect(result.descriptors).toHaveLength(2);
    for (const d of result.descriptors) {
      expect(d.source).toBe("composio");
    }
    expect(result.descriptors.map((d) => d.name).sort()).toEqual([
      "GMAIL_SEND_EMAIL",
      "SLACK_POST_MESSAGE",
    ]);
  });

  it("passes principal.userId and the config allowlist through to fetchTools", async () => {
    const { client, fetchTools, calls } = fakeClient(twoToolSet());
    const config: ComposioConfig = { toolkits: ["gmail"], tools: ["SLACK_POST_MESSAGE"] };

    await ingestComposioTools({ principal, config, client });

    expect(fetchTools).toHaveBeenCalledTimes(1);
    expect(calls[0]!.userId).toBe("user_123");
    expect(calls[0]!.allowlist).toEqual({
      toolkits: ["gmail"],
      tools: ["SLACK_POST_MESSAGE"],
    });
  });

  it("fails closed when principal.userId is empty (does not call the client)", async () => {
    const { client, fetchTools } = fakeClient(twoToolSet());
    const config: ComposioConfig = { toolkits: ["gmail"] };

    const result = await ingestComposioTools({
      principal: { userId: "" },
      config,
      client,
    });

    expect(result).toEqual({ toolset: {}, descriptors: [] });
    expect(fetchTools).not.toHaveBeenCalled();
  });

  it("fails closed when the allowlist is entirely empty (does not call the client)", async () => {
    const { client, fetchTools } = fakeClient(twoToolSet());
    const config: ComposioConfig = {};

    const result = await ingestComposioTools({ principal, config, client });

    expect(result).toEqual({ toolset: {}, descriptors: [] });
    expect(fetchTools).not.toHaveBeenCalled();
  });

  it("fails closed when toolkits/tools are present but empty arrays", async () => {
    const { client, fetchTools } = fakeClient(twoToolSet());
    const config: ComposioConfig = { toolkits: [], tools: [] };

    const result = await ingestComposioTools({ principal, config, client });

    expect(result).toEqual({ toolset: {}, descriptors: [] });
    expect(fetchTools).not.toHaveBeenCalled();
  });
});

describe("createComposioClient", () => {
  it("returns a client with a fetchTools function without hitting the network", () => {
    const client = createComposioClient({ apiKey: "x" });
    expect(typeof client.fetchTools).toBe("function");
  });
});
