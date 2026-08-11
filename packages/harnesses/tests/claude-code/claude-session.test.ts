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
  type ClaudeSession,
  type ClaudeTurnEvent,
} from "../../src/claude-code/claude-turn.js";

interface ScriptedTurn {
  say?: string;
  use?: { name: string; input: Record<string, unknown> };
  /** Hold this step until the test lets it go — the only way to observe that a
   *  caller's promise is still PENDING while the session is still working. */
  gate?: () => Promise<void>;
}

interface SessionRecord {
  /** How many times `query()` was called — ONE for a whole conversation. */
  queries: number;
  /** Every prompt the SDK actually received, in order, off the input iterable. */
  prompts: string[];
  /** The options the (single) query was opened with. */
  options: Record<string, any>;
  /** Every tool the scripted turns used, in order. */
  used: string[];
}

/**
 * What the SDK yields once it has answered a message — the shape this double used
 * to have no way of varying.
 *
 * It hard-coded exactly ONE `result` per message read, which IS the assumption the
 * session's steer bookkeeping made, so no test here could ever disagree with the
 * session about it. The engine's own contract is looser, and READ FROM THE SHIPPED
 * ENGINE (0.3.214, `sdk.d.ts` + the CLI's own message schemas):
 *
 *   - ZERO: a message the engine folds into the turn already running produces no
 *     boundary of its own. Its `still_queued` docs say a dequeued batch is
 *     "coalesced into one turn", and a `shouldQuery: false` message is "merged
 *     into the next user message that does query" — one turn, one result, two
 *     messages. This is the shape steering is DOCUMENTED to have ("the SDK hands
 *     the message to the model at its next step boundary").
 *   - ONE: the shape this double used to be able to produce, and the only one.
 *   - SEVERAL: results are held back while background work finishes and then
 *     flushed together, so more than one can land back to back.
 *
 * `idle` is the engine's own answer to the question a count can only guess at: a
 * `session_state_changed` event whose schema calls `idle` the "authoritative
 * turn-over signal".
 */
interface MessageBoundary {
  /** How many `result` messages this message's turn yields. */
  results?: number;
  /** Whether the session then announces it has nothing left to do. */
  idle?: boolean;
}

/**
 * A faithful stand-in for a STREAMING-INPUT session: it drains the async iterable
 * the caller hands `query()`, and for each user message it plays that message's
 * scripted turn and then yields that message's {@link MessageBoundary} — which is
 * how the real SDK says "this turn is done" while the input stream stays open.
 */
function fakeSessionSdk(
  script: (prompt: string, index: number) => ScriptedTurn[],
  record: SessionRecord,
  /** Per-message, by index. One result and no idle announcement is the default
   *  because it is the shape the engine has been SEEN to have; the point of the
   *  knob is that the session must not require it. */
  boundary: (index: number) => MessageBoundary = () => ({ results: 1 }),
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
          let index = 0;
          // The INPUT ITERABLE is the live session: this loop only ends when the
          // caller closes the stream, which is what `end()` must do.
          for await (const message of prompt as AsyncIterable<any>) {
            const text = typeof message.message.content === "string"
              ? message.message.content
              : String(message.message.content?.[0]?.text ?? "");
            record.prompts.push(text);
            for (const step of script(text, index)) {
              if (step.gate !== undefined) await step.gate();
              if (step.say !== undefined) {
                yield {
                  type: "assistant",
                  uuid: `asst_${index}`,
                  message: { content: [{ type: "text", text: step.say }] },
                };
              }
              if (step.use === undefined) continue;
              // No permission dispatch to simulate: the session runs in
              // `bypassPermissions` (D1), and an `mcp__vendo__*` use is dispatched
              // by the ENGINE over HTTP to the host's door — out of this process.
              record.used.push(step.use.name);
            }
            const { results = 1, idle = false } = boundary(index);
            index += 1;
            for (let n = 0; n < results; n += 1) {
              yield {
                type: "result",
                subtype: "success",
                session_id: sessionId,
                usage: { input_tokens: 10, output_tokens: 4 },
              };
            }
            if (idle) {
              yield { type: "system", subtype: "session_state_changed", state: "idle", session_id: sessionId };
            }
          }
        },
      };
    },
  };
}

function openSession(
  script: (prompt: string, index: number) => ScriptedTurn[],
  extra: Record<string, unknown> = {},
  boundary?: (index: number) => MessageBoundary,
) {
  const events: ClaudeTurnEvent[] = [];
  const record: SessionRecord = { queries: 0, prompts: [], options: {}, used: [] };
  const session = createClaudeSession({
    cwd: "/workspace",
    env: {},
    emit: (event: ClaudeTurnEvent) => events.push(event),
    sdk: fakeSessionSdk(script, record, boundary) as never,
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
    // The ENGINE dispatches it over HTTP — nothing executes in this process,
    // which is what deleted the bridge.
    expect(record.used).toEqual([`mcp__${VENDO_MCP_SERVER}__maple_invoices_list`]);
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

  test("the engine is asked to announce when it goes idle — the signal a steered turn ends on", async () => {
    const { session, record } = openSession(() => [{ say: "ok" }], { env: { PATH: "/usr/bin" } });
    await session.send("hi");
    await session.end();
    // The engine emits `session_state_changed` only when asked to. Unasked, a
    // steered turn is back to guessing how many results to expect, so this is
    // part of the loop's protocol rather than the operator's preference.
    expect(record.options["env"]).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    });
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
      cwd: "/workspace",
      env: {},
      emit: (event: ClaudeTurnEvent) => events.push(event),
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

/** A promise plus the handle that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("steering the turn in flight", () => {
  test("the words ride the SAME open input stream — one query(), two prompts, one turn", async () => {
    const record: SessionRecord = { queries: 0, prompts: [], options: {}, used: [] };
    const events: ClaudeTurnEvent[] = [];
    let session: ClaudeSession | undefined;
    session = createClaudeSession({
      cwd: "/workspace",
      env: {},
      emit: (event: ClaudeTurnEvent) => {
        events.push(event);
        // The user types mid-build. `emit` is called from INSIDE the SDK's drain
        // of message 1, so this push lands while message 1's turn is running —
        // which is the whole situation `steer` exists for.
        if (event.type === "text" && event.delta === "building it") {
          expect(session!.steer("group by client instead")).toBe(true);
        }
      },
      sdk: fakeSessionSdk(
        (_prompt, index) => [{ say: index === 0 ? "building it" : "Got it — regrouping by client." }],
        record,
      ) as never,
    } as never);

    await session.send("build me a reconciliation workbench");
    await session.end();

    // ONE query for the conversation: a steer is a PUSH into an inbox that never
    // closed, never a second session and never a second turn.
    expect(record.queries).toBe(1);
    expect(record.prompts).toEqual(["build me a reconciliation workbench", "group by client instead"]);
    expect(events.filter((event) => event.type === "text").map((event) => (event as { delta: string }).delta))
      .toEqual(["building it", "Got it — regrouping by client."]);
  });

  test("a steer does NOT settle the caller's turn early", async () => {
    // THE EARLY-SETTLE TRAP. Every extra user message the SDK answers produces
    // its own `result`, and `send()` settles on the next one it sees. A naive
    // steer therefore resolves the ORIGINAL send() at message 1's result — the
    // box door then marks the message done, the poll loop returns, and the turn
    // ends on the wire while the box is still working on the steer.
    const record: SessionRecord = { queries: 0, prompts: [], options: {}, used: [] };
    const gate = deferred();
    const entered = deferred();
    let session: ClaudeSession | undefined;
    session = createClaudeSession({
      cwd: "/workspace",
      env: {},
      emit: (event: ClaudeTurnEvent) => {
        if (event.type === "text" && event.delta === "building it") session!.steer("group by client instead");
      },
      sdk: fakeSessionSdk(
        (_prompt, index) => (index === 0
          ? [{ say: "building it" }]
          // Message 2's turn is HELD open, so "is send() still pending?" has a
          // deterministic answer rather than a microtask race.
          : [{ gate: async () => { entered.resolve(); await gate.promise; }, say: "Got it" }]),
        record,
      ) as never,
    } as never);

    const sending = session.send("build me a reconciliation workbench");
    let settled = false;
    void sending.then(() => { settled = true; });

    await entered.promise;
    // Drain every microtask and macrotask that can run while the steer's turn is
    // held. Nothing left to do but wait on the gate.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    gate.resolve();
    await sending;
    expect(record.prompts).toEqual(["build me a reconciliation workbench", "group by client instead"]);
    await session.end();
  });

  test("one result per steered message: the turn ends when the LAST one does", async () => {
    // The count-shaped case, now ONE case among three rather than the shape the
    // double could only produce. The boundary is stated here, so a reader can see
    // which engine behaviour this test speaks for.
    const record: SessionRecord = { queries: 0, prompts: [], options: {}, used: [] };
    let session: ClaudeSession | undefined;
    session = createClaudeSession({
      cwd: "/workspace",
      env: {},
      emit: (event: ClaudeTurnEvent) => {
        if (event.type !== "text") return;
        if (event.delta === "one") session!.steer("second thought");
        if (event.delta === "two") session!.steer("third thought");
      },
      sdk: fakeSessionSdk(
        (_prompt, index) => [{ say: ["one", "two", "three"][index] ?? "done" }],
        record,
        () => ({ results: 1 }),
      ) as never,
    } as never);

    await session.send("start");
    expect(record.prompts).toEqual(["start", "second thought", "third thought"]);
    await session.end();
  });

  test("a steer the engine FOLDS into the running turn still ends the caller's send()", async () => {
    // THE HANG, and the reason a count cannot be the authority. The turn used to
    // require one extra `result` per steer — a prediction about the engine, not a
    // fact about it. A message coalesced into the turn already running yields no
    // boundary of its own, so the count outlived the work: the FINAL result was
    // swallowed too, `send()` never settled, and the caller waited out the whole
    // message budget for a turn that had already finished.
    const record: SessionRecord = { queries: 0, prompts: [], options: {}, used: [] };
    let session: ClaudeSession | undefined;
    session = createClaudeSession({
      cwd: "/workspace",
      env: {},
      emit: (event: ClaudeTurnEvent) => {
        if (event.type === "text" && event.delta === "building it") session!.steer("group by client instead");
      },
      sdk: fakeSessionSdk(
        (_prompt, index) => [{ say: index === 0 ? "building it" : "regrouping" }],
        record,
        // The steer's words ride the turn already running: ONE boundary for both
        // messages, and then the engine says it has nothing left to do.
        (index) => (index === 0 ? { results: 0 } : { results: 1, idle: true }),
      ) as never,
    } as never);

    let settled = false;
    const sending = session.send("build me a reconciliation workbench");
    void sending.then(() => { settled = true; });
    // One macrotask drains the whole scripted session — the fake holds no timers.
    // Both messages read, one result, then idle: nothing is left that could ever
    // settle this caller, so a still-pending send here is a permanent hang.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(record.prompts).toEqual(["build me a reconciliation workbench", "group by client instead"]);
    expect(settled).toBe(true);

    await sending;
    await session.end();
  });

  test("two steers and ONE result: idle clears the whole wait, not one steer of it", async () => {
    const record: SessionRecord = { queries: 0, prompts: [], options: {}, used: [] };
    let session: ClaudeSession | undefined;
    session = createClaudeSession({
      cwd: "/workspace",
      env: {},
      emit: (event: ClaudeTurnEvent) => {
        if (event.type !== "text") return;
        if (event.delta === "one") session!.steer("second thought");
        if (event.delta === "two") session!.steer("third thought");
      },
      sdk: fakeSessionSdk(
        (_prompt, index) => (index === 0 ? [{ say: "one" }, { say: "two" }] : [{ say: "regrouping" }]),
        record,
        // Both steers fold into the first turn, so the session sees ONE result and
        // two steers. A wait that unwound one steer per signal would still be
        // short by one when the engine went quiet.
        (index) => (index === 0 ? { results: 1 } : { results: 0, idle: index === 2 }),
      ) as never,
    } as never);

    let settled = false;
    const sending = session.send("start");
    void sending.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(record.prompts).toEqual(["start", "second thought", "third thought"]);
    expect(settled).toBe(true);

    await sending;
    await session.end();
  });

  test("several results back to back never outlast the steers that were pushed", async () => {
    // The other end of the same unknown: results are held back while background
    // work finishes and then flushed together, so one message's answer can arrive
    // as several boundaries. The wait is a CAP — it ends at the steers actually
    // pushed — and the surplus is dropped where it lands rather than banked for
    // whoever sends next.
    const record: SessionRecord = { queries: 0, prompts: [], options: {}, used: [] };
    let session: ClaudeSession | undefined;
    session = createClaudeSession({
      cwd: "/workspace",
      env: {},
      emit: (event: ClaudeTurnEvent) => {
        if (event.type === "text" && event.delta === "one") session!.steer("second thought");
      },
      sdk: fakeSessionSdk(
        (_prompt, index) => [{ say: ["one", "two", "three"][index] ?? "done" }],
        record,
        (index) => (index === 0 ? { results: 3 } : { results: 1 }),
      ) as never,
    } as never);

    await session.send("start");
    // The next caller's turn is its OWN: it settles on a boundary that arrives
    // after the engine has read its message, never on a leftover.
    await session.send("and now this");
    expect(record.prompts).toEqual(["start", "second thought", "and now this"]);
    await session.end();
  });

  test("a steer with no turn in flight is refused — there would be nobody to settle it", async () => {
    const { session } = openSession(() => [{ say: "ok" }]);
    expect(session.steer("too early")).toBe(false);
    await session.send("hi");
    expect(session.steer("too late")).toBe(false);
    await session.end();
  });

  test("stop after a steer still ends the turn — a swallowed result must not outlive an interrupt", async () => {
    // The interrupt cuts the session's remaining work short, so the extra
    // `result` a steer was counting on may never arrive. Left counted, the
    // caller's promise would hang to the message budget (15 minutes).
    const record: SessionRecord = { queries: 0, prompts: [], options: {}, used: [] };
    let session: ClaudeSession | undefined;
    session = createClaudeSession({
      cwd: "/workspace",
      env: {},
      emit: (event: ClaudeTurnEvent) => {
        if (event.type === "text" && event.delta === "building it") {
          session!.steer("group by client instead");
          // Stop, before the SDK ever reaches the steered message.
          void session!.interrupt();
        }
      },
      sdk: {
        query: ({ prompt }: { prompt: unknown }) => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "system", subtype: "init", session_id: "s" };
            for await (const _message of prompt as AsyncIterable<unknown>) {
              record.prompts.push("m");
              yield { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "building it" }] } };
              // An interrupted session answers ONE result and stops reading its
              // input — the steered message is never picked up.
              yield { type: "result", subtype: "success", session_id: "s" };
              return;
            }
          },
          interrupt: async () => undefined,
        }),
      } as never,
    } as never);

    await expect(session.send("build me a reconciliation workbench")).resolves.toBeUndefined();
    await session.end();
  });

  test("the steer × beats seam: no `finishing` on a steered result, and the rework re-narrates its phase", async () => {
    // The seam #810 (beats) and this PR (steer) create together, which neither
    // tested alone. A steered result is an INTERMEDIATE boundary, so:
    //   - `finishing` must fire ONCE, on the FINAL result — never on the steered
    //     one, or the build claims to be done while the correction's rework is
    //     still ahead (§3.4, no progress-lie);
    //   - a phase beat must fire AGAIN in the rework, because the steer carries
    //     the turn on and `narrated.clear()` frees it to re-narrate — that IS the
    //     mockup's scene 3 ("Regrouping by client" as a fresh beat).
    const events: ClaudeTurnEvent[] = [];
    let session: ClaudeSession | undefined;
    session = createClaudeSession({
      cwd: "/workspace",
      env: {},
      emit: (event: ClaudeTurnEvent) => {
        events.push(event);
        if (event.type === "text" && event.delta === "building it") {
          session!.steer("group by client instead");
        }
      },
      sdk: {
        query: ({ prompt }: { prompt: unknown }) => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "system", subtype: "init", session_id: "s" };
            let index = 0;
            for await (const _message of prompt as AsyncIterable<unknown>) {
              // Both the first pass and the rework hit a WRITING tool, so each
              // SHOULD produce a `building` beat — the second only if narration
              // was cleared on the steered result in between.
              yield { type: "assistant", uuid: `w${index}`, message: { content: [{ type: "tool_use", name: "Write" }] } };
              yield {
                type: "assistant",
                uuid: `t${index}`,
                message: { content: [{ type: "text", text: index === 0 ? "building it" : "regrouping" }] },
              };
              yield { type: "result", subtype: "success", session_id: "s" };
              index += 1;
            }
          },
        }),
      } as never,
    } as never);

    await session.send("build me a reconciliation workbench");
    await session.end();

    const phases = events.filter((event) => event.type === "status").map((event) => (event as { phase: string }).phase);
    // `finishing` exactly once — the final result only, never the steered one.
    expect(phases.filter((phase) => phase === "finishing")).toEqual(["finishing"]);
    // `building` twice — the rework re-narrated, which only happens if the
    // steered result cleared narration. Without that clear this would be one.
    expect(phases.filter((phase) => phase === "building")).toEqual(["building", "building"]);
  });
});
