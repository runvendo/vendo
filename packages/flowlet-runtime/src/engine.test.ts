import { describe, it, expect, vi } from "vitest";
import { tool } from "ai";
import type { Tool, ToolSet } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod";
import { SCHEMA_VERSION } from "@flowlet/core";
import type { AuditEvent, AuditLog, FlowletUIMessage } from "@flowlet/core";
import { createFlowletAgent, RENDER_VIEW_TOOL_NAME, REQUEST_CONNECT_TOOL_NAME } from "./engine";
import { auditPolicy, composePolicy, volumeBreaker, createBreakerState } from "./policy";
import type { ApprovalPolicy, PolicyContext } from "./policy";
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

  it("writes a data-consent part for a gated tool call", async () => {
    const gatedTool = {
      description: "mutate something",
      inputSchema: z.object({}),
      annotations: { destructiveHint: false },
      execute: async () => "done",
    } as unknown as Tool;
    const approvePolicy: ApprovalPolicy = { evaluate: () => "approve" };

    const agent = createFlowletAgent({
      model: mockModel({ toolName: "mutate_thing", input: {} }),
      policy: approvePolicy,
      tools: { mutate_thing: gatedTool },
    });

    const parts = await collect(
      agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }),
    );
    const consentParts = parts.filter((p) => (p as { type: string }).type === "data-consent");
    expect(consentParts).toHaveLength(1);
  });

  it("calls onSettled with the run's final messages and threadId once the stream finishes", async () => {
    const onSettled = vi.fn();
    const agent = createFlowletAgent({
      model: mockModel(),
      policy: allowPolicy,
      onSettled,
    });

    await collect(
      agent.run({
        messages: userTurn,
        tools: {},
        signal: new AbortController().signal,
        threadId: "conv-42",
      }),
    );

    expect(onSettled).toHaveBeenCalledOnce();
    const settled = onSettled.mock.calls[0]![0] as {
      messages: FlowletUIMessage[];
      threadId: string;
    };
    // The hook receives the SAME threadId run() resolved — the caller's id
    // when supplied — so a host can attribute persistence per conversation.
    expect(settled.threadId).toBe("conv-42");
    // ai@6.0.28's handleUIMessageStreamFinish returns [...originalMessages,
    // state.message] — the FULL updated list, not just the new turn. Assert
    // the prior user message survives alongside the new assistant reply.
    expect(settled.messages).toContainEqual(userTurn[0]);
    expect(
      settled.messages.some(
        (m) =>
          m.role === "assistant" &&
          m.parts.some((p) => (p as { type: string; text?: string }).type === "text" && (p as { text?: string }).text === "All done."),
      ),
    ).toBe(true);
  });

  it("onSettled receives the engine's minted threadId when the caller supplies none", async () => {
    const onSettled = vi.fn();
    const agent = createFlowletAgent({
      model: mockModel(),
      policy: allowPolicy,
      onSettled,
    });

    await collect(
      agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }),
    );

    expect(onSettled).toHaveBeenCalledOnce();
    const settled = onSettled.mock.calls[0]![0] as { threadId: string };
    expect(settled.threadId).toMatch(/^thread-\d+$/);
  });

  it("threads a caller-supplied threadId into PolicyContext (contextKey)", async () => {
    const seenThreadIds: (string | undefined)[] = [];
    const policy: ApprovalPolicy = {
      evaluate: (ctx) => {
        seenThreadIds.push(ctx.threadId);
        return "allow";
      },
    };
    const payload = {
      formatVersion: "flowlet-genui/v1",
      root: "r",
      nodes: [{ id: "r", component: "Text", props: { text: "Hi" } }],
    };
    const agent = createFlowletAgent({
      model: mockModel({ toolName: RENDER_VIEW_TOOL_NAME, input: payload }),
      policy,
    });

    await collect(
      agent.run({
        messages: userTurn,
        tools: {},
        threadId: "conv-1",
        signal: new AbortController().signal,
      }),
    );

    expect(seenThreadIds).toContain("conv-1");
  });

  it("falls back to its own minted threadId when the caller supplies none", async () => {
    const seenThreadIds: (string | undefined)[] = [];
    const policy: ApprovalPolicy = {
      evaluate: (ctx) => {
        seenThreadIds.push(ctx.threadId);
        return "allow";
      },
    };
    const payload = {
      formatVersion: "flowlet-genui/v1",
      root: "r",
      nodes: [{ id: "r", component: "Text", props: { text: "Hi" } }],
    };
    const agent = createFlowletAgent({
      model: mockModel({ toolName: RENDER_VIEW_TOOL_NAME, input: payload }),
      policy,
    });

    await collect(
      agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }),
    );

    expect(seenThreadIds.some((id) => /^thread-\d+$/.test(id ?? ""))).toBe(true);
  });

  it("assembles PolicyContext.request from the latest user message", async () => {
    const seen: PolicyContext[] = [];
    const spyPolicy: ApprovalPolicy = { evaluate: (ctx) => { seen.push(ctx); return "allow"; } };
    const agent = createFlowletAgent({
      model: mockModel({ toolName: "some_tool", input: {} }),
      policy: spyPolicy,
      tools: { some_tool: tool({ inputSchema: z.object({}), execute: async () => "ok" }) },
    });
    await collect(agent.run({
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "email Jim that I'm running late" }] }],
      tools: {},
      signal: new AbortController().signal,
    }));
    const seenWithRequest = seen.find((ctx) => ctx.toolName === "some_tool");
    expect(seenWithRequest?.request).toEqual({ text: "email Jim that I'm running late", messageId: "m1" });
  });

  it("counters increment across multiple tool calls within the SAME run", async () => {
    // Mock model: turn 1 calls tool A, turn 2 (prompt now carries A's tool-call)
    // calls tool B, turn 3 finishes. Reuses this file's mockModel shape but
    // needs a two-call sequence — write a small dedicated mock inline here
    // rather than extending the shared `mockModel` (it only supports one call).
    const counts: Record<string, number>[] = [];
    const spyPolicy: ApprovalPolicy = {
      evaluate: (ctx) => { counts.push({ ...ctx.counters!.perTool }); return "allow"; },
    };
    const twoStepModel = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const calls = prompt.filter(
          (m) => m.role === "assistant" && Array.isArray(m.content) &&
            m.content.some((c) => (c as { type?: string }).type === "tool-call"),
        ).length;
        const chunks: LanguageModelV3StreamPart[] =
          calls === 0
            ? [{ type: "tool-call", toolCallId: "c1", toolName: "tool_a", input: "{}" },
               { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } }]
            : calls === 1
              ? [{ type: "tool-call", toolCallId: "c2", toolName: "tool_b", input: "{}" },
                 { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } }]
              : [...textChunks("t", "done"), { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } }];
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    const agent = createFlowletAgent({
      model: twoStepModel,
      policy: spyPolicy,
      tools: {
        tool_a: tool({ inputSchema: z.object({}), execute: async () => "a" }),
        tool_b: tool({ inputSchema: z.object({}), execute: async () => "b" }),
      },
    });
    await collect(agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }));
    // tool_a's needsApproval sees {tool_a:1}; tool_b's sees {tool_a:1, tool_b:1}
    // (both counted once via recordCall, needsApproval-only — see run-context.ts).
    expect(counts.some((c) => c["tool_a"] === 1 && c["tool_b"] === undefined)).toBe(true);
    expect(counts.some((c) => c["tool_a"] === 1 && c["tool_b"] === 1)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Client-executed tool audit (ENG-193 review follow-up — queued gap): the
  // Trust diary read 0 tool_execution events despite live client-tool sends
  // because there is no server-side `execute` for `auditPolicy.onExecuted`
  // to observe. The engine scans the run's INCOMING messages for
  // output-available client-tool parts and appends the event itself.
  // ---------------------------------------------------------------------
  describe("client-executed tool audit", () => {
    function clientTool(annotations: Record<string, boolean>): Tool {
      return {
        description: "a host tool executed in the browser",
        inputSchema: z.object({}),
        annotations,
        flowletExecutor: "client",
      } as unknown as Tool;
    }

    function historyWithClientResult(toolCallId: string): FlowletUIMessage[] {
      return [
        { id: "m1", role: "user", parts: [{ type: "text", text: "send it" }] },
        {
          id: "m2",
          role: "assistant",
          parts: [
            {
              type: "tool-send_thing",
              toolCallId,
              state: "output-available",
              input: { to: "a@b.com" },
              output: { ok: true },
            },
          ],
        },
      ] as unknown as FlowletUIMessage[];
    }

    function makeAudit(): AuditLog & { events: AuditEvent[] } {
      const events: AuditEvent[] = [];
      return {
        events,
        append: vi.fn(async (event: AuditEvent) => {
          events.push(event);
        }),
        query: vi.fn(async () => events),
      };
    }

    // ENG-193 PR #40 review (item G): client-tool auditing now happens by
    // routing through the COMPOSED `policy`'s own `onExecuted` (auditPolicy
    // appends the event, volumeBreaker counts) instead of the engine
    // appending to a separately-wired `audit` log — so every test below
    // composes `auditPolicy` into `policy` itself, exactly as a real host's
    // policy stack does (`composeProductionPolicy`/`demoPolicy` both already
    // wire `auditPolicy` this way).
    function policyWithAudit(audit: AuditLog): ApprovalPolicy {
      return composePolicy(allowPolicy, auditPolicy(audit, { principalScope: (ctx) => ({ tenantId: "t", subject: ctx.principal.userId }) }));
    }

    it("appends exactly one tool_execution event for an output-available client-tool part", async () => {
      const audit = makeAudit();
      const agent = createFlowletAgent({
        model: mockModel(),
        policy: policyWithAudit(audit),
      });

      await collect(
        agent.run({
          messages: historyWithClientResult("call-client-1"),
          tools: { send_thing: clientTool({ readOnlyHint: false, destructiveHint: false }) },
          principal: { userId: "user-1" },
          signal: new AbortController().signal,
        }),
      );

      const toolEvents = audit.events.filter((e) => e.kind === "tool_execution");
      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0]).toMatchObject({
        kind: "tool_execution",
        toolName: "send_thing",
        toolCallId: "call-client-1",
        mutating: true,
        dangerous: false,
        outcome: "ok",
        principal: { tenantId: "t", subject: "user-1" },
      });
    });

    it("never audits a SERVER-executed tool's output-available part (only client)", async () => {
      const audit = makeAudit();
      const agent = createFlowletAgent({
        model: mockModel(),
        policy: policyWithAudit(audit),
      });
      const serverTool = tool({
        description: "server tool",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: false },
        execute: async () => "done",
      });

      await collect(
        agent.run({
          messages: historyWithClientResult("call-server-1"),
          tools: { send_thing: serverTool },
          signal: new AbortController().signal,
        }),
      );

      expect(audit.events.filter((e) => e.kind === "tool_execution")).toHaveLength(0);
    });

    it("dedupes: running the SAME messages again through the SAME engine never double-audits", async () => {
      const audit = makeAudit();
      const agent = createFlowletAgent({
        model: mockModel(),
        policy: policyWithAudit(audit),
      });
      const tools = { send_thing: clientTool({ readOnlyHint: false, destructiveHint: false }) };
      const messages = historyWithClientResult("call-client-2");

      await collect(agent.run({ messages, tools, signal: new AbortController().signal }));
      await collect(agent.run({ messages, tools, signal: new AbortController().signal }));

      expect(audit.events.filter((e) => e.kind === "tool_execution")).toHaveLength(1);
    });

    it("REGRESSION (ENG-193 PR #40 review — item G): a client-tool execution now counts toward volumeBreaker's threshold", async () => {
      const audit = makeAudit();
      const state = createBreakerState();
      const policy = volumeBreaker(policyWithAudit(audit), state, { threshold: 1 });
      const tools = { send_thing: clientTool({ readOnlyHint: false, destructiveHint: false }) };
      const agent = createFlowletAgent({ model: mockModel(), policy });

      // First call executes under the threshold...
      await collect(
        agent.run({
          messages: historyWithClientResult("call-vol-1"),
          tools,
          principal: { userId: "user-1" },
          threadId: "th-1",
          signal: new AbortController().signal,
        }),
      );
      // ...a SECOND client tool call in the same thread is now past threshold
      // 1 and must be forced to "approve" by volumeBreaker's evaluate — proof
      // the first call was actually COUNTED via onExecuted.
      const forced = await policy.evaluate({
        toolName: "send_thing",
        input: {},
        descriptor: { name: "send_thing", source: "caller", annotations: { readOnlyHint: false }, hasExecute: false, kind: "function", executor: "client" },
        principal: { userId: "user-1" },
        threadId: "th-1",
      });
      expect(forced).toBe("approve");
      expect(audit.events.filter((e) => e.kind === "tool_execution")).toHaveLength(1);
    });

    it("is a no-op when no audit config is supplied (graceful default)", async () => {
      const agent = createFlowletAgent({ model: mockModel(), policy: allowPolicy });
      const parts = await collect(
        agent.run({
          messages: historyWithClientResult("call-noop"),
          tools: { send_thing: clientTool({ readOnlyHint: false }) },
          signal: new AbortController().signal,
        }),
      );
      expect(parts.map((p) => (p as { type: string }).type)).toContain("finish");
    });
  });

  describe("tool source labeling (ENG-193 PR #40 review — item A)", () => {
    /** Records every descriptor.source the policy sees, keyed by tool name. */
    function recordingPolicy(): { policy: ApprovalPolicy; sources: Record<string, string> } {
      const sources: Record<string, string> = {};
      return {
        sources,
        policy: {
          evaluate: (ctx: PolicyContext) => {
            sources[ctx.toolName] = ctx.descriptor.source;
            return "allow";
          },
        },
      };
    }

    it('config.tools (host-supplied server tools) land under source "engine", NOT the control-plane bucket', async () => {
      const { policy, sources } = recordingPolicy();
      const agent = createFlowletAgent({
        model: mockModel({ toolName: "issue_refund", input: {} }),
        policy,
        tools: {
          issue_refund: tool({ inputSchema: z.object({}), execute: async () => "ok" }),
        },
      });
      await collect(agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }));
      expect(sources["issue_refund"]).toBe("engine");
    });

    it('config.controlTools (steering/authoring) land under source "control", alongside render_view/request_connect', async () => {
      const { policy, sources } = recordingPolicy();
      const agent = createFlowletAgent({
        model: mockModel({ toolName: "always_ask_before", input: {} }),
        policy,
        controlTools: {
          always_ask_before: tool({ inputSchema: z.object({}), execute: async () => "ok" }),
        },
      });
      await collect(agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }));
      expect(sources["always_ask_before"]).toBe("control");
    });

    it("render_view and request_connect are always source \"control\", never \"engine\"", async () => {
      const { policy, sources } = recordingPolicy();
      const payload = {
        formatVersion: "flowlet-genui/v1",
        root: "r1",
        nodes: [{ id: "r1", component: "Text", source: "prewired", props: { text: "hi" } }],
      };
      const agent = createFlowletAgent({
        model: mockModel({ toolName: RENDER_VIEW_TOOL_NAME, input: payload }),
        policy,
      });
      await collect(agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }));
      expect(sources[RENDER_VIEW_TOOL_NAME]).toBe("control");
    });
  });
});
