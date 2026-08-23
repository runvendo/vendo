/**
 * THE HAND-ROLLED LOOP, end to end, with nothing between the two halves.
 *
 * `vendo.agentTools` is only worth anything if the thing it hands back drives a
 * real conversation against a real door: a real service-key exchange, a real
 * MCP session, the real `cautious` guard parking a real write, the real
 * approvals wire resolving it, and the real replay running it on the same
 * session. Every one of those is here, unstubbed — a harness that faked the
 * door would prove the helper agrees with itself.
 *
 * The Anthropic types are the OTHER counterparty, and they are real too: the
 * blocks handed in are `Anthropic.ContentBlock`s and the blocks handed back are
 * assigned to `Anthropic.ContentBlockParam`s, so "Anthropic-Messages-shaped" is
 * checked by their compiler rather than claimed by this file.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { vendoApprovalRefSchema, type ToolDescriptor, type ToolRegistry } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  principal,
  runCleanups,
  SUBJECT,
  tapWhenItAppears,
  tempStore,
} from "../src/mcp-door.test-util.js";
import { createVendo, type Vendo } from "../src/server.js";

afterEach(runCleanups);
afterEach(() => {
  vi.useRealTimers();
});

const KEY = "vsk_0123456789abcdef0123456789abcdef0123456789abcdef";
const BASE = "https://host.test";
const READ = "host_lookupClient";
const WRITE = "host_sendClientMessage";

/** A host with one read the `cautious` policy runs and one write it parks —
 *  and a ledger of what actually got delivered, which is the only honest
 *  witness that an approved retry EXECUTED rather than parked again. */
function messagingHost(): { tools: ToolRegistry; delivered: string[] } {
  const delivered: string[] = [];
  const descriptors: ToolDescriptor[] = [
    {
      name: READ,
      title: "Look up a client",
      description: "Look up a client",
      inputSchema: { type: "object", properties: { clientId: { type: "string" } }, required: ["clientId"] },
      risk: "read",
    },
    {
      name: WRITE,
      title: "Message a client",
      description: "Message a client about their account",
      inputSchema: {
        type: "object",
        properties: { clientId: { type: "string" }, body: { type: "string" } },
        required: ["clientId", "body"],
      },
      risk: "write",
    },
  ];
  return {
    delivered,
    tools: {
      async descriptors() {
        return descriptors;
      },
      async execute(call) {
        if (call.tool !== WRITE) return { status: "ok", output: { name: "Ada" } };
        delivered.push((call.args as { body: string }).body);
        return { status: "ok", output: { sent: true } };
      },
    },
  };
}

const compose = async (): Promise<{ vendo: Vendo; host: ReturnType<typeof messagingHost> }> => {
  const store = await tempStore();
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    guard: { policy: "cautious" },
    mcp: { serviceAuth: { keys: [KEY] }, baseUrl: BASE },
    oauth: {
      async authorize() {
        return { subject: SUBJECT };
      },
      async principal(subject: string) {
        return { kind: "user", subject };
      },
    },
  } as Parameters<typeof createVendo>[0]);
  const host = messagingHost();
  vendo.actions.add(host.tools);
  await store.ensureSchema();
  return { vendo, host };
};

/** An assistant turn as the Messages API really shapes one. Typed with
 *  Anthropic's own `ContentBlock`, so a drift in what `results` accepts is a
 *  compile error here rather than a runtime surprise in a host's loop. */
const assistant = (...calls: Array<{ id: string; name: string; input: unknown }>): {
  content: Anthropic.ContentBlock[];
} => ({
  content: [
    { type: "text", text: "on it", citations: null },
    ...calls.map((call) => ({
      type: "tool_use" as const,
      caller: { type: "direct" as const },
      id: call.id,
      name: call.name,
      input: call.input,
    })),
  ],
});

describe("vendo.agentTools", () => {
  it("lists this user's tools and answers a read with blocks the Messages API takes back", async () => {
    const { vendo } = await compose();
    const door = await vendo.agentTools(SUBJECT);

    const read = door.tools.find((tool) => tool.name === READ);
    expect(read?.description).toBe("Look up a client");
    expect(read?.input_schema.type).toBe("object");
    // STRAIGHT into `messages.create({ tools })` — no spread, no cast, no
    // annotation. Anthropic's own type is the assertion, and the missing
    // `[...]` is the point: a `readonly` list would not have compiled here.
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      tools: door.tools,
      messages: [{ role: "user", content: "what is my balance?" }],
    };
    expect(params.tools).toHaveLength(door.tools.length);

    const results = await door.results(assistant({ id: "toolu_read", name: READ, input: { clientId: "c_1" } }));
    expect(results).toEqual([{
      type: "tool_result",
      tool_use_id: "toolu_read",
      content: [{ type: "text", text: '{"name":"Ada"}' }],
      is_error: false,
    }]);
    // …and straight back in as the next user message.
    const next: Anthropic.MessageParam = { role: "user", content: results };
    expect(next.content).toHaveLength(1);
    // A clean run is plain data, not an envelope: nothing for the page to render.
    expect(door.embeds).toEqual([]);
  });

  it("answers a turn that called nothing with [] — which is how the loop ends", async () => {
    const { vendo } = await compose();
    const door = await vendo.agentTools(SUBJECT);
    expect(await door.results(assistant())).toEqual([]);
  });

  it("parks a write as a TYPED embed, and the retry on the same door runs it once approved", async () => {
    const { vendo, host } = await compose();
    const door = await vendo.agentTools(SUBJECT);
    const input = { clientId: "c_1", body: "your statement is ready" };

    const parked = await door.results(assistant({ id: "toolu_park", name: WRITE, input }));
    expect(parked[0]?.is_error).toBe(true);
    // The model's half: the sentence, unchanged.
    expect(parked[0]?.content[0]?.text).toContain("needs approval");
    expect(host.delivered).toEqual([]);

    // The page's half: the typed envelope, off `structuredContent` and nowhere
    // else. Parsed through core's schema — the reader's contract, not a shape
    // this file copied.
    const ref = vendoApprovalRefSchema.parse(door.embeds[0]);
    expect(ref.summary).toContain(WRITE);
    // One approval, two spellings of it: the prose names what the field carries.
    expect(parked[0]?.content[0]?.text).toContain(ref.approvalId);

    // The person resolves it in the product, over the real approvals wire.
    expect(await tapWhenItAppears(vendo, WRITE, true)).toBe(ref.approvalId);

    // The model retries the same call. SAME door, so the same MCP session: the
    // door hands the guard back the id it parked, and the write lands. A helper
    // that reconnected per call would park here a second time instead.
    const done = await door.results(assistant({ id: "toolu_retry", name: WRITE, input }));
    expect(done[0]?.is_error).toBe(false);
    expect(host.delivered).toEqual(["your statement is ready"]);
    expect(door.embeds).toHaveLength(1);
  });

  it("keeps going after the ten-minute badge runs out mid-conversation", async () => {
    const { vendo } = await compose();
    const door = await vendo.agentTools(SUBJECT);
    expect((await door.results(assistant({ id: "toolu_1", name: READ, input: { clientId: "c_1" } })))[0]?.is_error)
      .toBe(false);

    // Only the clock: real timers keep every await honest while the door's
    // service token ages past its ten minutes.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);

    const late = await door.results(assistant({ id: "toolu_2", name: READ, input: { clientId: "c_1" } }));
    expect(late[0]?.is_error).toBe(false);
    expect(late[0]?.content[0]?.text).toBe('{"name":"Ada"}');
  });

  it("names the fix a misconfigured deployment actually needs", async () => {
    const bare = async (mcp: unknown): Promise<Vendo> => {
      const store = await tempStore();
      const vendo = createVendo({
        models: { default: {} as LanguageModel },
        principal: async () => principal,
        store,
        ...(mcp === undefined ? {} : { mcp }),
        oauth: {
          async authorize() {
            return { subject: SUBJECT };
          },
          async principal(subject: string) {
            return { kind: "user", subject };
          },
        },
      } as Parameters<typeof createVendo>[0]);
      await store.ensureSchema();
      return vendo;
    };

    // No door at all is the likelier mistake, and it must not be answered with
    // the base-URL fix — which is what asking the questions the other way round
    // would say.
    await expect((await bare(undefined)).agentTools(SUBJECT)).rejects.toThrow(/no door is open/);
    // A door, but nothing has ever told this deployment its own public URL.
    await expect((await bare({ serviceAuth: { keys: [KEY] } })).agentTools(SUBJECT))
      .rejects.toThrow(/VENDO_BASE_URL/);
  });
});
