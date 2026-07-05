import { describe, it, expect, vi } from "vitest";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod";
import { SCHEMA_VERSION } from "@flowlet/core";
import type { FlowletUIMessage } from "@flowlet/core";
import { createFlowletAgent, RENDER_VIEW_TOOL_NAME, REQUEST_CONNECT_TOOL_NAME } from "./engine";
import type { ApprovalPolicy } from "./policy";
import type { ComposioClient } from "./composio";

// Replace `createComposioClient` with a spy so we can assert the engine builds
// the client ONCE and reuses it across runs (Finding 4). `ingestComposioTools`
// and everything else keep their real implementations.
vi.mock("./composio", async (importActual) => {
  const actual = await importActual<typeof import("./composio")>();
  return {
    ...actual,
    createComposioClient: vi.fn(
      (): ComposioClient => ({
        fetchTools: vi.fn(async () => ({})),
        authorize: vi.fn(async () => ({ redirectUrl: null, connectedAccountId: "ca_fake" })),
        connectionStatus: vi.fn(async () => "active" as const),
        hasActiveConnection: vi.fn(async () => true),
      }),
    ),
  };
});

// ---------------------------------------------------------------------------
// Offline mock-model scaffolding (mirrors flowlet-core/src/stub-agent.ts).
// ---------------------------------------------------------------------------

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

function textChunks(id: string, text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
  ];
}

/** True once the conversation already contains an assistant tool call. */
function promptHasToolCall(prompt: { role: string; content: unknown }[]): boolean {
  return prompt.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      m.content.some((c) => (c as { type?: string }).type === "tool-call"),
  );
}

/**
 * Mock model: turn 1 streams text + (optionally) a single tool-call; once the
 * prompt carries that tool-call (turn 2+), streams text only and finishes, so
 * the model->tool loop terminates.
 */
function mockModel(call?: { toolName: string; input: unknown }): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const chunks: LanguageModelV3StreamPart[] =
        call === undefined || promptHasToolCall(prompt)
          ? [
              ...textChunks("t-done", "All done."),
              { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
            ]
          : [
              ...textChunks("t1", "Working on it."),
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: call.toolName,
                input: JSON.stringify(call.input),
              },
              { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

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

const allowPolicy: ApprovalPolicy = { evaluate: () => "allow" };

const userTurn: FlowletUIMessage[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "go" }] },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createFlowletAgent", () => {
  it("emits a valid UIMessage stream with run metadata and a data-ui node", async () => {
    const payload = {
      formatVersion: "flowlet-genui/v1",
      root: "r",
      nodes: [{ id: "r", component: "Text", props: { text: "Hi" } }],
    };
    const agent = createFlowletAgent({
      model: mockModel({ toolName: RENDER_VIEW_TOOL_NAME, input: payload }),
      policy: allowPolicy,
    });

    const parts = await collect(
      agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }),
    );
    const types = parts.map((p) => (p as { type: string }).type);

    // Valid stream shape: starts with `start`, ends with `finish`.
    expect(types).toContain("start");
    expect(types).toContain("text-delta");
    expect(types).toContain("finish");

    // Run identity rides as message metadata on the `start` chunk.
    const start = parts.find((p) => (p as { type: string }).type === "start") as {
      messageMetadata?: { runId: string; threadId: string; schemaVersion: number };
    };
    expect(start.messageMetadata?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof start.messageMetadata?.runId).toBe("string");
    expect(start.messageMetadata?.runId.length).toBeGreaterThan(0);
    expect(typeof start.messageMetadata?.threadId).toBe("string");
    expect(start.messageMetadata?.threadId.length).toBeGreaterThan(0);

    // The render tool executed and emitted a data-ui generated-view node.
    const ui = parts.find((p) => (p as { type: string }).type === "data-ui") as {
      data: { kind: string; payload: unknown };
    };
    expect(ui).toBeDefined();
    expect(ui.data.kind).toBe("generated");
    expect(ui.data.payload).toEqual(payload);
  });

  it("registers render_view and request_connect but not render_ui", async () => {
    // Capture the toolset the engine hands to streamText by reading the tools
    // the SDK forwards to the model's doStream (provider-format function tools,
    // each carrying a `name`).
    let capturedTools: { name: string }[] | undefined;
    const model = new MockLanguageModelV3({
      doStream: async ({ tools }) => {
        capturedTools = tools as { name: string }[] | undefined;
        return {
          stream: simulateReadableStream({
            chunks: [
              ...textChunks("t-done", "All done."),
              { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
            ],
          }),
        };
      },
    });

    const agent = createFlowletAgent({ model, policy: allowPolicy });
    await collect(
      agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }),
    );

    const names = (capturedTools ?? []).map((t) => t.name);
    expect(names).toContain(RENDER_VIEW_TOOL_NAME);
    expect(names).toContain(REQUEST_CONNECT_TOOL_NAME);
    expect(names).not.toContain("render_ui");
  });

  it("scopes Composio ingestion to the run principal's userId", async () => {
    const fetchTools = vi.fn(async (): Promise<ToolSet> => ({}));
    const client: ComposioClient = {
      fetchTools,
      authorize: vi.fn(async () => ({ redirectUrl: null, connectedAccountId: "ca_fake" })),
      connectionStatus: vi.fn(async () => "active" as const),
      hasActiveConnection: vi.fn(async () => true),
    };

    const agent = createFlowletAgent({
      model: mockModel(),
      policy: allowPolicy,
      composio: { config: { toolkits: ["gmail"] }, client },
    });

    await collect(
      agent.run({
        messages: userTurn,
        tools: {},
        principal: { userId: "user-42" },
        signal: new AbortController().signal,
      }),
    );

    expect(fetchTools).toHaveBeenCalledOnce();
    expect(fetchTools.mock.calls[0][0]).toBe("user-42");
    expect(fetchTools.mock.calls[0][1]).toEqual({ toolkits: ["gmail"], tools: undefined });
  });

  it("surfaces the SDK native abort when the signal is aborted (no hang, no throw)", async () => {
    const agent = createFlowletAgent({ model: mockModel(), policy: allowPolicy });
    const controller = new AbortController();
    controller.abort();

    const parts = await collect(
      agent.run({ messages: userTurn, tools: {}, signal: controller.signal }),
    );
    const types = parts.map((p) => (p as { type: string }).type);

    // Aborted signal short-circuits streamText: it emits `abort` and the stream
    // completes rather than hanging or throwing.
    expect(types).toContain("abort");
    expect(types).not.toContain("data-ui");
  });

  it("merges a caller-supplied tool into the loop so the model can call it", async () => {
    const callerExecute = vi.fn(async () => "echoed");
    const callerTool = tool({
      description: "Echo a message.",
      inputSchema: z.object({ msg: z.string() }),
      execute: callerExecute,
    });

    const agent = createFlowletAgent({
      model: mockModel({ toolName: "caller_echo", input: { msg: "hi" } }),
      policy: allowPolicy,
    });

    await collect(
      agent.run({
        messages: userTurn,
        tools: { caller_echo: callerTool },
        signal: new AbortController().signal,
      }),
    );

    expect(callerExecute).toHaveBeenCalledOnce();
    expect(callerExecute.mock.calls[0][0]).toEqual({ msg: "hi" });
  });

  it("warns when a tool name collides across sources (Finding 2)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Caller claims `render_view`, colliding with the engine's built-in render
      // tool (lower precedence) — the engine tool is dropped and logged.
      const callerTool = tool({ inputSchema: z.object({}), execute: async () => "x" });
      const agent = createFlowletAgent({ model: mockModel(), policy: allowPolicy });

      await collect(
        agent.run({
          messages: userTurn,
          tools: { [RENDER_VIEW_TOOL_NAME]: callerTool },
          signal: new AbortController().signal,
        }),
      );

      expect(warnSpy).toHaveBeenCalled();
      const logged = warnSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(logged).toContain(RENDER_VIEW_TOOL_NAME);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("builds the Composio client once and reuses it across runs (Finding 4)", async () => {
    const { createComposioClient } = await import("./composio");
    const spy = createComposioClient as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const agent = createFlowletAgent({
      model: mockModel(),
      policy: allowPolicy,
      // No client injected → the engine must build one (and only one).
      composio: { config: { toolkits: ["gmail"] } },
    });

    await collect(
      agent.run({
        messages: userTurn,
        tools: {},
        principal: { userId: "user-a" },
        signal: new AbortController().signal,
      }),
    );
    await collect(
      agent.run({
        messages: userTurn,
        tools: {},
        principal: { userId: "user-b" },
        signal: new AbortController().signal,
      }),
    );

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("tolerates a caller passing undefined tools (Finding 5)", async () => {
    const agent = createFlowletAgent({ model: mockModel(), policy: allowPolicy });

    const parts = await collect(
      agent.run({
        messages: userTurn,
        // Non-TS caller may omit `tools` entirely.
        tools: undefined as unknown as ToolSet,
        signal: new AbortController().signal,
      }),
    );

    expect(parts.map((p) => (p as { type: string }).type)).toContain("finish");
  });

  it("repairs history a stale turn would wedge: unanswered approvals become denials, aborted input-* calls are dropped", async () => {
    // Capture the prompt the model actually receives.
    let seenPrompt: { role: string; content: unknown }[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        seenPrompt = prompt as typeof seenPrompt;
        return {
          stream: simulateReadableStream({
            chunks: [
              ...textChunks("t-ok", "Continuing."),
              { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
            ] satisfies LanguageModelV3StreamPart[],
          }),
        };
      },
    });
    const agent = createFlowletAgent({ model, policy: allowPolicy });

    const history = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "set it up" }] },
      {
        id: "m2",
        role: "assistant",
        parts: [
          // The user typed past this approval card — no response ever recorded.
          {
            type: "tool-mutate_thing",
            toolCallId: "call-stale",
            state: "approval-requested",
            input: { a: 1 },
            approval: { id: "appr-1" },
          },
          // An aborted stream left this call with no output.
          {
            type: "tool-render_view",
            toolCallId: "call-aborted",
            state: "input-available",
            input: { name: "Card" },
          },
        ],
      },
      { id: "m3", role: "user", parts: [{ type: "text", text: "actually just tell me a joke" }] },
    ] as unknown as FlowletUIMessage[];

    const parts = await collect(
      agent.run({ messages: history, tools: {}, signal: new AbortController().signal }),
    );

    // The run completed rather than erroring on a dangling tool_use…
    expect(parts.map((p) => (p as { type: string }).type)).toContain("finish");
    // …the stale approval reached the model as a completed (denied) call…
    const toolMessages = seenPrompt.filter((m) => m.role === "tool");
    const results = toolMessages.flatMap((m) => m.content as { type: string; toolCallId: string }[]);
    expect(results.some((r) => r.type === "tool-result" && r.toolCallId === "call-stale")).toBe(true);
    // …and the aborted input-available call was dropped entirely (every
    // tool-call in the prompt has a matching tool-result).
    const calls = seenPrompt
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c): c is { type: string; toolCallId: string } => (c as { type?: string }).type === "tool-call");
    for (const call of calls) {
      expect(results.some((r) => r.type === "tool-result" && r.toolCallId === call.toolCallId)).toBe(true);
    }
    expect(calls.some((c) => c.toolCallId === "call-aborted")).toBe(false);
  });

  it("repairs a stale DYNAMIC tool approval (MCP tools) the same way", async () => {
    let seenPrompt: { role: string; content: unknown }[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        seenPrompt = prompt as typeof seenPrompt;
        return {
          stream: simulateReadableStream({
            chunks: [
              ...textChunks("t-ok", "Continuing."),
              { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
            ] satisfies LanguageModelV3StreamPart[],
          }),
        };
      },
    });
    const agent = createFlowletAgent({ model, policy: allowPolicy });

    const history = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "echo something" }] },
      {
        id: "m2",
        role: "assistant",
        parts: [
          // An MCP tool call (dynamic-tool part) the user typed past.
          {
            type: "dynamic-tool",
            toolName: "everything_echo",
            toolCallId: "call-stale-dyn",
            state: "approval-requested",
            input: { message: "hi" },
            approval: { id: "appr-dyn" },
          },
        ],
      },
      { id: "m3", role: "user", parts: [{ type: "text", text: "never mind" }] },
    ] as unknown as FlowletUIMessage[];

    const parts = await collect(
      agent.run({ messages: history, tools: {}, signal: new AbortController().signal }),
    );

    expect(parts.map((p) => (p as { type: string }).type)).toContain("finish");
    const results = seenPrompt
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content as { type: string; toolCallId: string }[]);
    expect(results.some((r) => r.type === "tool-result" && r.toolCallId === "call-stale-dyn")).toBe(true);
  });
});

describe("MCP ingestion wiring", () => {
  // Must be a REAL ai-SDK tool: the engine hands the toolset to streamText,
  // which calls asSchema(tool.inputSchema) — a bare `{}` schema crashes there.
  const echoTool = tool({
    description: "echo",
    inputSchema: z.object({}),
    execute: async () => "ok",
  });

  function fakeMcpSource(result?: {
    tools: ToolSet;
    annotations: Record<string, Record<string, boolean>>;
    failures?: never;
  }) {
    return {
      fetchTools: vi.fn(async () =>
        result ?? { tools: { ping: echoTool }, annotations: { ping: { readOnlyHint: true } } },
      ),
    };
  }

  it("ingests MCP tools once (host-level cache) across runs and principals", async () => {
    const source = fakeMcpSource();
    const agent = createFlowletAgent({
      model: mockModel(),
      policy: allowPolicy,
      mcp: { servers: [{ name: "srv", url: "http://x" }], source },
    });

    await collect(
      agent.run({ messages: userTurn, tools: {}, principal: { userId: "u1" }, signal: new AbortController().signal }),
    );
    await collect(
      agent.run({ messages: userTurn, tools: {}, principal: { userId: "u2" }, signal: new AbortController().signal }),
    );

    expect(source.fetchTools).toHaveBeenCalledTimes(1);
  });

  it("retries MCP ingestion on a later run after a failure (failures are not cached past the retry delay)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = {
      fetchTools: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue({ tools: { ping: echoTool }, annotations: {} }),
    };
    const agent = createFlowletAgent({
      model: mockModel(),
      policy: allowPolicy,
      // retryDelayMs 0 = retry on the very next turn (the default backs off 30s).
      mcp: { servers: [{ name: "srv", url: "http://x" }], source, retryDelayMs: 0 },
    });

    await collect(agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }));
    await collect(agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }));

    expect(source.fetchTools).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("MCP tools flow through the policy wrapper and execute like any source", async () => {
    const ran = vi.fn(async () => "mcp-ran");
    const source = {
      fetchTools: vi.fn(async () => ({
        tools: {
          ping: tool({ description: "ping", inputSchema: z.object({}), execute: ran }),
        },
        annotations: { ping: { readOnlyHint: true } },
      })),
    };
    const agent = createFlowletAgent({
      model: mockModel({ toolName: "srv_ping", input: {} }),
      policy: allowPolicy,
      mcp: { servers: [{ name: "srv", url: "http://x" }], source },
    });

    const parts = await collect(
      agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }),
    );
    expect(ran).toHaveBeenCalledOnce();
    expect(parts.map((p) => (p as { type: string }).type)).toContain("finish");
  });

  it("caller tools take precedence over MCP tools on a name collision", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const callerRan = vi.fn(async () => "caller-won");
    const mcpRan = vi.fn(async () => "mcp-lost");
    const source = {
      fetchTools: vi.fn(async () => ({
        tools: { ping: tool({ description: "mcp ping", inputSchema: z.object({}), execute: mcpRan }) },
        annotations: {},
      })),
    };
    const agent = createFlowletAgent({
      model: mockModel({ toolName: "srv_ping", input: {} }),
      policy: allowPolicy,
      mcp: { servers: [{ name: "srv", url: "http://x" }], source },
    });

    await collect(
      agent.run({
        messages: userTurn,
        tools: {
          srv_ping: tool({ description: "caller ping", inputSchema: z.object({}), execute: callerRan }),
        },
        signal: new AbortController().signal,
      }),
    );

    expect(callerRan).toHaveBeenCalledOnce();
    expect(mcpRan).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tool "srv_ping" from source "mcp" dropped'));
    warn.mockRestore();
  });

  it("runs fine with no mcp config at all", async () => {
    const agent = createFlowletAgent({ model: mockModel(), policy: allowPolicy });
    const parts = await collect(
      agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }),
    );
    expect(parts.map((p) => (p as { type: string }).type)).toContain("finish");
  });
});
