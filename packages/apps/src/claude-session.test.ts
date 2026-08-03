/**
 * The live session — cc-native's whole point.
 *
 * Today's shape is a cold start per message: one `query()` per turn, a `resume`
 * ref, and a re-seed from our transcript when the resume is not available. The
 * live shape is ONE `query()` per conversation with a streaming input: the user's
 * next message is PUSHED into a session that never stopped, exactly like typing
 * a second line at a Claude Code prompt.
 *
 * This file pins that difference where it is observable: the number of `query()`
 * calls, the fact that message 2 arrives through the input iterable, and that the
 * session id never changes across messages.
 */
import { describe, expect, test } from "vitest";
import {
  createClaudeSession,
  VENDO_MCP_SERVER,
  type ClaudeTurnEvent,
  type ClaudeTurnTool,
  type GuardedCall,
} from "./claude-turn.js";

interface ScriptedTurn {
  say?: string;
  use?: { name: string; input: Record<string, unknown> };
}

interface SessionRecord {
  /** How many times `query()` was called — ONE for a whole conversation. */
  queries: number;
  /** Every prompt the SDK actually received, in order, off the input iterable. */
  prompts: string[];
  /** The options the (single) query was opened with. */
  options: Record<string, any>;
  permissions: Array<{ name: string; verdict: string }>;
}

/**
 * A faithful stand-in for a STREAMING-INPUT session: it drains the async iterable
 * the caller hands `query()`, and for each user message it plays that message's
 * scripted turn and then yields a `result` — which is how the real SDK says "this
 * turn is done" while the input stream stays open.
 */
function fakeSessionSdk(
  script: (prompt: string, index: number) => ScriptedTurn[],
  record: SessionRecord,
  sessionId = "sess_live",
) {
  return {
    tool: (name: string, description: string, inputSchema: unknown, handler: unknown) =>
      ({ name, description, inputSchema, handler }),
    createSdkMcpServer: (options: { name: string; tools?: unknown[] }) => ({
      __tools: options.tools ?? [],
    }),
    query: ({ prompt, options }: { prompt: unknown; options: Record<string, any> }) => {
      record.queries += 1;
      record.options = options;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: sessionId, model: "claude-test" };
          const handlers = new Map<string, any>(
            ((options.mcpServers?.[VENDO_MCP_SERVER]?.__tools ?? []) as any[]).map(
              (entry) => [`mcp__${VENDO_MCP_SERVER}__${entry.name}`, entry],
            ),
          );
          let index = 0;
          // The INPUT ITERABLE is the live session: this loop only ends when the
          // caller closes the stream, which is what `end()` must do.
          for await (const message of prompt as AsyncIterable<any>) {
            const text = typeof message.message.content === "string"
              ? message.message.content
              : String(message.message.content?.[0]?.text ?? "");
            record.prompts.push(text);
            for (const step of script(text, index)) {
              if (step.say !== undefined) {
                yield {
                  type: "assistant",
                  uuid: `asst_${index}`,
                  message: { content: [{ type: "text", text: step.say }] },
                };
              }
              if (step.use === undefined) continue;
              let verdict: any = { behavior: "allow", updatedInput: step.use.input };
              if (!(options.allowedTools ?? []).includes(step.use.name) && options.canUseTool) {
                verdict = await options.canUseTool(step.use.name, step.use.input, {
                  signal: new AbortController().signal,
                });
              }
              record.permissions.push({ name: step.use.name, verdict: verdict.behavior });
              if (verdict.behavior !== "allow") continue;
              const entry = handlers.get(step.use.name);
              if (entry !== undefined) {
                const raw = (verdict.updatedInput ?? step.use.input) as Record<string, unknown>;
                const declared = Object.keys((entry.inputSchema ?? {}) as Record<string, unknown>);
                await entry.handler(
                  Object.fromEntries(declared.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]])),
                  {},
                );
              }
            }
            index += 1;
            yield {
              type: "result",
              subtype: "success",
              session_id: sessionId,
              usage: { input_tokens: 10, output_tokens: 4 },
            };
          }
        },
      };
    },
  };
}

const listing: ClaudeTurnTool[] = [
  {
    name: "maple_invoices_list",
    title: "List invoices",
    description: "List the signed-in user's invoices",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
];

const ok: GuardedCall = async () => ({ status: "ok", output: { invoices: [] } });

function openSession(
  script: (prompt: string, index: number) => ScriptedTurn[],
  extra: Record<string, unknown> = {},
) {
  const events: ClaudeTurnEvent[] = [];
  const record: SessionRecord = { queries: 0, prompts: [], options: {}, permissions: [] };
  const session = createClaudeSession({
    tools: listing,
    cwd: "/workspace",
    env: {},
    callTool: ok,
    emit: (event) => events.push(event),
    sdk: fakeSessionSdk(script, record) as never,
    ...extra,
  } as never);
  return { session, events, record };
}

describe("one session per conversation, chat in / stream out", () => {
  test("two messages ride ONE query() — the session is never restarted", async () => {
    const { session, record } = openSession((prompt) => [{ say: `heard: ${prompt}` }]);

    await session.send("what do I owe?");
    await session.send("and the oldest one?");
    await session.end();

    expect(record.queries).toBe(1);
    expect(record.prompts).toEqual(["what do I owe?", "and the oldest one?"]);
  });

  test("send() settles on ITS OWN turn's result, so a second message is never sent into a running turn", async () => {
    const seen: string[] = [];
    const { session } = openSession((prompt) => {
      seen.push(`start:${prompt}`);
      return [{ say: "ok" }];
    });

    await session.send("first");
    // If send() resolved early, "second" would be pushed before the first turn
    // finished and the fake's ordered drain would interleave them.
    expect(seen).toEqual(["start:first"]);
    await session.send("second");
    expect(seen).toEqual(["start:first", "start:second"]);
    await session.end();
  });

  test("the session id is announced once and stays the same across messages", async () => {
    const { session, events } = openSession(() => [{ say: "ok" }]);
    await session.send("one");
    await session.send("two");
    await session.end();

    const ids = events.filter((event) => event.type === "session").map((event) => event.sessionId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe("sess_live");
  });

  test("text from every message's turn reaches the caller in order", async () => {
    const { session, events } = openSession((prompt) => [{ say: `re: ${prompt}` }]);
    await session.send("alpha");
    await session.send("beta");
    await session.end();

    expect(events.filter((event) => event.type === "text").map((event) => (event as { delta: string }).delta))
      .toEqual(["re: alpha", "re: beta"]);
  });

  test("the host's door rides the SESSION, so every message of a conversation reaches the same tools", async () => {
    const toolDoor = { url: "https://app.example.com/api/vendo/mcp", token: "vtk_live" };
    const { session, record } = openSession(
      (_prompt, index) => (index === 0
        ? [{ use: { name: `mcp__${VENDO_MCP_SERVER}__maple_invoices_list`, input: { limit: 2 } } }]
        : [{ say: "done" }]),
      { toolDoor },
    );
    await session.send("list them");
    await session.send("thanks");
    await session.end();

    // ONE `query()` for the conversation, so the door's URL and credential are
    // set once and serve every message. The credential survives that because its
    // AUTHORITY is per turn, not per token (`turn-credentials.ts`).
    expect(record.options["mcpServers"]).toEqual({
      [VENDO_MCP_SERVER]: {
        type: "http",
        url: toolDoor.url,
        headers: { Authorization: `Bearer ${toolDoor.token}` },
        alwaysLoad: true,
      },
    });
    // The hook allows it and the ENGINE dispatches it over HTTP — nothing
    // executes in this process, which is what deleted the bridge.
    expect(record.permissions[0]?.verdict).toBe("allow");
  });

  test("two CONCURRENT sends are serialized — both settle, in order, and neither hangs", async () => {
    // Why the queue is kept rather than deleted. `settleTurn` is ONE slot: two
    // overlapping sends would both write it, so the first caller's promise would
    // never be resolved — a request that hangs forever, which is strictly worse
    // than a 409.
    //
    // The box door does 409 a concurrent /session/message, so the sandbox path is
    // safe without this. `machine: "local"` has no such door: two POSTs for the
    // same thread reach ONE in-process session, and nothing above guarantees the
    // runtime serializes same-thread turns. Eight lines to rule out a permanent
    // hang is the cheaper side of that trade.
    const { session, record } = openSession((prompt) => [{ say: `re: ${prompt}` }]);

    const both = Promise.all([session.send("first"), session.send("second")]);
    await expect(both).resolves.toEqual([undefined, undefined]);
    expect(record.prompts).toEqual(["first", "second"]);
    expect(record.queries).toBe(1);
    await session.end();
  });

  test("end() closes the input stream, so the SDK's own loop finishes", async () => {
    const { session } = openSession(() => [{ say: "ok" }]);
    await session.send("hi");
    // A session that never closed its iterable would hang here forever.
    await expect(session.end()).resolves.toBeUndefined();
  });
});

describe("the four channels the live session opens", () => {
  test("the appended prompt is a few lines, not a wall", async () => {
    const { session, record } = openSession(() => [{ say: "ok" }], {
      systemPrompt: "You are embedded in Maple.",
    });
    await session.send("hi");
    await session.end();

    expect(record.options["systemPrompt"]).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are embedded in Maple.",
    });
  });

  test("skills arrive as a native local PLUGIN, and the engine is told we own the MCP wiring", async () => {
    const { session, record } = openSession(() => [{ say: "ok" }], {
      pluginPath: "/workspace/host",
    });
    await session.send("hi");
    await session.end();

    expect(record.options["plugins"]).toEqual([
      { type: "local", path: "/workspace/host", skipMcpDiscovery: true },
    ]);
    // `skills` is the SDK's single switch for turning discovered skills on; a
    // plugin whose skills are never enabled is a directory nobody reads.
    expect(record.options["skills"]).toEqual([]);
    // Multi-tenant isolation is NOT weakened to get skills: the user's own files
    // still cannot configure the harness.
    expect(record.options["settingSources"]).toEqual([]);
  });

  test("no skills directory means no plugins key at all — never an empty plugin list", async () => {
    const { session, record } = openSession(() => [{ say: "ok" }]);
    await session.send("hi");
    await session.end();
    expect(record.options).not.toHaveProperty("plugins");
    expect(record.options).not.toHaveProperty("skills");
  });

  test("a PostToolUse hook reports the files a turn wrote, which is what replaces file-watch polling", async () => {
    const wrote: string[] = [];
    const { session, record } = openSession(() => [{ say: "ok" }], {
      onFileWritten: (path: string) => wrote.push(path),
    });
    await session.send("build me an app");

    // The SDK calls the hook; we assert on OUR side of it.
    const hook = record.options["hooks"]?.PostToolUse?.[0]?.hooks?.[0];
    expect(typeof hook).toBe("function");
    await hook({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/workspace/user/apps/app_1/app.vendo" },
      tool_response: {},
      tool_use_id: "tu_1",
    });
    expect(wrote).toEqual(["/workspace/user/apps/app_1/app.vendo"]);
    await session.end();
  });

  test("partial messages are requested, so text streams as tokens rather than in one block", async () => {
    const { session, record } = openSession(() => [{ say: "ok" }]);
    await session.send("hi");
    await session.end();
    expect(record.options["includePartialMessages"]).toBe(true);
  });

  test("text that already streamed as deltas is NOT repeated by the assistant message that completes it", async () => {
    // MEASURED LIVE 2026-08-02: turning `includePartialMessages` on made the SDK
    // emit BOTH the token deltas and the finished assistant block, and the user
    // saw every sentence twice ("I'll find and update the dashboard heading for
    // you.I'll find and update the dashboard heading for you."). The completed
    // block is the same prose, so whichever arrives first wins and the other is
    // dropped.
    const events: ClaudeTurnEvent[] = [];
    const session = createClaudeSession({
      tools: listing,
      cwd: "/workspace",
      env: {},
      callTool: ok,
      emit: (event) => events.push(event),
      sdk: {
        tool: () => ({}),
        createSdkMcpServer: () => ({}),
        query: ({ prompt }: { prompt: unknown }) => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "system", subtype: "init", session_id: "s" };
            for await (const _message of prompt as AsyncIterable<unknown>) {
              // Real order: the deltas stream, THEN the finished block arrives.
              yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } };
              yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "there." } } };
              yield { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "Hello there." }] } };
              yield { type: "result", subtype: "success", session_id: "s" };
            }
          },
        }),
      } as never,
    });
    await session.send("hi");
    await session.end();

    const said = events.filter((event) => event.type === "text").map((event) => (event as { delta: string }).delta);
    expect(said.join("")).toBe("Hello there.");
    // The completed block is dropped ENTIRELY, not merged: nothing else on it is
    // needed now that the rewind ledger (which wanted its uuid) is gone.
    expect(said).toEqual(["Hello ", "there."]);
  });

  test("an SDK that never streams deltas still yields the assistant block's text", async () => {
    // The fallback must stay real: if partial messages are unavailable, dropping
    // the completed block would mean the user sees nothing at all.
    const { session, events } = openSession(() => [{ say: "only the block" }]);
    await session.send("hi");
    await session.end();
    expect(events.filter((event) => event.type === "text").map((event) => (event as { delta: string }).delta))
      .toEqual(["only the block"]);
  });
});
