/**
 * The SANDBOX leg of the live proof: a real e2b machine, the real box image,
 * the real inverted bridge, the real Agent SDK inside the box.
 *
 * Gated on `E2B_API_KEY` + `ANTHROPIC_API_KEY` + `VENDO_BOX_TEMPLATE` (the
 * template `packages/apps/box/build-template.mjs` bakes — it carries the turn
 * door and `claude-turn.mjs`). Skipped otherwise, like every `.live.test.ts`.
 *
 * It lives in the UMBRELLA's suite because it needs both blocks — the real e2b
 * adapter (`@vendoai/apps/e2b`) driving the harness driver (`@vendoai/harnesses`)
 * — and harnesses no longer depends on apps.
 */
import { e2bSandbox } from "@vendoai/apps/e2b";
import type { Json, ToolResult, Turn } from "@vendoai/core";
import { afterAll, describe, expect, test } from "vitest";
import { createTurnState } from "@vendoai/harnesses";
import {
  boxEgress,
  boxMachine,
  claudeCode,
  disposeSessionMachines,
  type SandboxAdapterLike,
} from "@vendoai/harnesses/claude-code";
import { testWorkspace, unusedModels, userMessage } from "../src/agent-doubles.test-util.js";

const ready = process.env["E2B_API_KEY"] !== undefined
  && process.env["ANTHROPIC_API_KEY"] !== undefined
  && process.env["VENDO_BOX_TEMPLATE"] !== undefined;
const live = ready ? describe : describe.skip;
const MODEL = process.env["VENDO_LIVE_MODEL"] ?? "claude-sonnet-4-5";

function harnessed(input: {
  say: string;
  files?: Record<string, string>;
  skills?: Array<{ name: string; description: string }>;
  tools?: Array<{ name: string; title: string; description: string; inputSchema?: Json }>;
  answer?: (name: string, args: Json) => ToolResult;
  thread: string;
  state?: string;
  /**
   * The transcript SO FAR, as the runtime supplies it.
   *
   * `Turn.messages` is the canonical thread read back from
   * `vendo_thread_messages` with the new user message upserted
   * (`packages/vendo/src/harness-turn.ts`), so on a real turn 2 it holds turn 1's
   * user message AND its reply. A double that hands one message per turn makes a
   * genuine next message look like a TRUNCATION to `truncated()`.
   */
  history?: Array<{ id: string; role: "user" | "assistant"; text: string }>;
}) {
  const workspace = testWorkspace(input.files ?? {});
  const calls: Array<{ name: string; args: Json }> = [];
  const state = createTurnState(input.state);
  const turn = {
    messages: [
      ...(input.history ?? []).map(({ id, role, text }) => (
        role === "user"
          ? userMessage(id, text)
          : { id, role: "assistant" as const, parts: [{ type: "text" as const, text }] }
      )),
      userMessage(input.thread, input.say),
    ],
    tools: {
      list: async () => (input.tools ?? []).map((tool) => ({ ...tool, risk: "read" as const })),
      call: async (name: string, args: Json) => {
        calls.push({ name, args });
        return input.answer?.(name, args) ?? { status: "ok" as const, output: { ok: true } };
      },
    },
    skills: {
      list: async () => input.skills ?? [],
      load: async () => "",
    },
    workspace,
    models: unusedModels(),
    state,
    options: {} as never,
    signal: AbortSignal.timeout(540_000),
    interactive: true,
    system: "You are the assistant inside Maple, a small business banking product.",
  } as unknown as Turn<never>;
  return { turn, workspace, calls, state };
}

/** The recorded v0 inference exception, and nothing else (design §9). */
const liveEnv = (): Record<string, string> => ({
  ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"]!,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
});

/** These tests drive `boxMachine` directly, so they own the network policy the
 *  harness would otherwise assemble. No door here — inference only. */
const liveEgress = (): string[] => boxEgress(liveEnv(), undefined);

live("claudeCode() — live, in a real e2b box", () => {
  afterAll(async () => { await disposeSessionMachines(); });

  const sandbox = (): SandboxAdapterLike => e2bSandbox({
    apiKey: process.env["E2B_API_KEY"]!,
    timeoutMs: 10 * 60_000,
  }) as unknown as SandboxAdapterLike;

  test("E3 · the box's real bash edits the app, and the diff lands in OUR store", async () => {
    const h = harnessed({
      thread: "m_box_edit",
      say: "The dashboard heading says 'Invoices'. Change it to say 'Bills' and nothing else.",
      files: {
        "/user/apps/app_box/app.vendo": '<App name="Money">\n  <Heading text="Invoices" />\n</App>\n',
        "/host/skills/refund/SKILL.md": "# refund\nHow refunds work here.\n",
      },
    });
    let text = "";
    for await (const event of claudeCode({ sandbox: sandbox(), model: MODEL, maxTurns: 14 })
      .run(h.turn as never)) {
      if (event.type === "text") text += event.delta;
      if (event.type === "error") text += `\n[error] ${event.message}`;
    }
    const after = await h.workspace.readFile("/user/apps/app_box/app.vendo");
    console.log("[live box edit]", JSON.stringify({ text, after, commits: h.workspace.commits }));
    expect(after).toContain("Bills");
    expect(text).not.toContain("[error]");
    // /host came along read-only and never came back.
    expect(await h.workspace.readFile("/host/skills/refund/SKILL.md")).toContain("How refunds work here.");
  }, 600_000);

  test("§1.3 · the pooled machine keeps its native session across turns", async () => {
    const adapter = sandbox();
    const first = harnessed({ thread: "m_box_session", say: "Remember the number 8823. Just say ok." });
    for await (const _ of claudeCode({ sandbox: adapter, model: MODEL, maxTurns: 6 }).run(first.turn as never)) {
      // drain
    }
    const carried = first.state.pending().value;
    expect(JSON.parse(carried!).sessionId).toMatch(/.+/);

    const second = harnessed({
      // Turn 2 carries the transcript, exactly as the runtime hands it over —
      // which is what makes this an APPEND rather than a truncation.
      history: [
        { id: "m_box_session", role: "user", text: "Remember the number 8823. Just say ok." },
        { id: "a_box_session", role: "assistant", text: "ok" },
      ],
      thread: "m_box_session_2",
      say: "What number did I ask you to remember? Reply with digits only.",
      state: carried!,
    });
    let text = "";
    for await (const event of claudeCode({ sandbox: adapter, model: MODEL, maxTurns: 6 })
      .run(second.turn as never)) {
      if (event.type === "text") text += event.delta;
      if (event.type === "error") text += `\n[error] ${event.message}`;
    }
    console.log("[live box session]", JSON.stringify({ carried, text }));
    expect(text).toContain("8823");
  }, 600_000);

  test("PROOF 1 · chat is real: two messages, ONE box, ONE session, no re-materialize between them", async () => {
    const adapter = sandbox();
    const thread = `thr_live_chat_${Date.now()}`;
    const drive = async (
      machine: Awaited<ReturnType<typeof boxMachine>>,
      prompt: string,
    ) => {
      let text = "";
      let sessionId: string | undefined;
      await machine.send({
        prompt,
        systemPrompt: "Answer in as few words as possible.",
        model: MODEL,
        maxTurns: 4,
        emit: (event) => {
          if (event.type === "text") text += event.delta;
          if (event.type === "session") sessionId = event.sessionId;
        },
      });
      return { text, sessionId };
    };

    // Message 1 on a FRESH box: materialize once, open the session.
    const first = await boxMachine({ sandbox: adapter, threadId: thread, env: liveEnv(), allowedDomains: liveEgress() });
    expect(first.carriesSession).toBe(false);
    await first.materialize([]);
    const opened = await drive(first, "Remember the number 7311. Just say ok.");
    expect(opened.sessionId).toMatch(/.+/);
    await first.release();

    // Message 2 on the SAME conversation. The box is warm, so nothing is
    // materialized and nothing is resumed — the session never stopped.
    const second = await boxMachine({ sandbox: adapter, threadId: thread, env: liveEnv(), allowedDomains: liveEgress() });
    expect(second.carriesSession).toBe(true);
    const recalled = await drive(second, "What number did I ask you to remember? Digits only.");
    console.log("[live chat]", JSON.stringify({ session: opened.sessionId, recalled: recalled.text }));
    // Turn 2 depends on turn 1's answer, and it lands — which is the whole lane.
    expect(recalled.text).toContain("7311");
    await second.release();
  }, 600_000);

  test("PROOF 5 · recovery: a box that DIED gets replaced, files come back, and the thread re-seeds", async () => {
    const adapter = sandbox();
    const thread = `thr_live_recover_${Date.now()}`;

    const first = await boxMachine({ sandbox: adapter, threadId: thread, env: liveEnv(), allowedDomains: liveEgress() });
    await first.materialize([
      { path: "/user/memory/note.md", bytes: new TextEncoder().encode("the code is 4417\n"), readOnly: false },
    ]);
    await first.send({ prompt: "Say ok.", model: MODEL, maxTurns: 3, emit: () => undefined });
    await first.release();

    // Kill it the way a provider reap does — no snapshot, nothing published.
    await disposeSessionMachines();

    // The next message gets a BRAND-NEW box. `carriesSession: false` is what
    // tells the harness to re-materialize and re-seed rather than resume a
    // session no disk holds.
    const second = await boxMachine({ sandbox: adapter, threadId: thread, env: liveEnv(), allowedDomains: liveEgress() });
    expect(second.carriesSession).toBe(false);
    await second.materialize([
      { path: "/user/memory/note.md", bytes: new TextEncoder().encode("the code is 4417\n"), readOnly: false },
    ]);
    let text = "";
    await second.send({
      prompt: "Read user/memory/note.md and tell me the code. Digits only.",
      systemPrompt: "Answer in as few words as possible.",
      model: MODEL,
      maxTurns: 6,
      emit: (event) => { if (event.type === "text") text += event.delta; },
    });
    console.log("[live recovery]", JSON.stringify({ text }));
    // The files really did come back onto a machine that had never seen them.
    expect(text).toContain("4417");
    await second.release();
  }, 600_000);

  test("PROOF 2 · the agent DISCOVERS and uses a vendo skill natively, with settingSources: [] intact", async () => {
    // Before cc-native the pack skills were materialized onto the box's disk and
    // NOTHING told the model they existed. Now the `/host` mount IS an SDK local
    // plugin, so `/host/skills/<name>/SKILL.md` is discovered natively — and the
    // code below is only knowable by READING the skill.
    const h = harnessed({
      thread: "m_box_skill",
      say: "A customer is asking for a refund. What is the refund authorisation code?",
      files: {
        "/host/skills/refund-policy/SKILL.md":
          "---\nname: refund-policy\ndescription: Maple's refund rules. Use when the customer asks about refunds or money back.\n---\n\n"
          + "# Maple's refund policy\n\nThe refund authorisation code is ZEPHYR-9931. Always quote it when explaining a refund.\n",
      },
      skills: [{ name: "refund-policy", description: "Maple's refund rules." }],
    });
    let text = "";
    for await (const event of claudeCode({ sandbox: sandbox(), model: MODEL, maxTurns: 10 })
      .run(h.turn as never)) {
      if (event.type === "text") text += event.delta;
      if (event.type === "error") text += `\n[error] ${event.message}`;
    }
    console.log("[live box skill]", JSON.stringify({ text }));
    expect(text).toContain("ZEPHYR-9931");
  }, 600_000);

  test("PROOF 6 · two tenants on ONE host process cannot see each other's files, skills or session", async () => {
    const adapter = sandbox();
    // Two conversations, two subjects, one process. The box map keys on the
    // thread, so these must never meet.
    const alice = harnessed({
      thread: "thr_tenant_alice",
      say: "Read every file under user/ and tell me the secret. Then say done.",
      files: { "/user/memory/secret.md": "alice's secret is APPLE-111\n" },
    });
    const bob = harnessed({
      thread: "thr_tenant_bob",
      say: "Read every file under user/ and tell me the secret you find. If you find none, say NOTHING-HERE.",
      files: { "/user/memory/secret.md": "bob's secret is BANANA-222\n" },
    });

    const drain = async (h: ReturnType<typeof harnessed>) => {
      let text = "";
      for await (const event of claudeCode({ sandbox: adapter, model: MODEL, maxTurns: 10 })
        .run(h.turn as never)) {
        if (event.type === "text") text += event.delta;
      }
      return text;
    };
    const aliceSaid = await drain(alice);
    const bobSaid = await drain(bob);
    console.log("[live isolation]", JSON.stringify({ aliceSaid, bobSaid }));

    // Each sees its OWN file...
    expect(aliceSaid).toContain("APPLE-111");
    expect(bobSaid).toContain("BANANA-222");
    // ...and never the other's, in either direction.
    expect(aliceSaid).not.toContain("BANANA-222");
    expect(bobSaid).not.toContain("APPLE-111");
    // Two boxes, because two conversations.
    expect(await alice.workspace.readFile("/user/memory/secret.md")).toContain("APPLE-111");
    expect(await bob.workspace.readFile("/user/memory/secret.md")).toContain("BANANA-222");
  }, 600_000);

  test("E7 · the box env holds no credential but inference — and no door credential either", async () => {
    // The tool half of this proof MOVED. `claudeCode()` reaches its tools
    // through the host's MCP door now, so a guarded call needs a composed host
    // at an origin the box can resolve — which is exactly what
    // `docs/verification/door-ctx/live-door-proof.mjs` drives, over a real
    // tunnel, and where the "one guard, one audit row, one mirror" assertions
    // now live. What CANNOT move is this half: whatever else changed, the
    // machine's environment still holds the inference key and nothing else.
    process.env["VENDO_LANE_E_BOX_CANARY"] = "never-in-a-box";
    const h = harnessed({
      thread: "m_box_env",
      say: "Write the full output of `env | sort` to user/files/env.txt. Then say done.",
    });
    try {
      // Drained to drive the turn; the proof is the env dump the agent writes,
      // not anything the stream says.
      for await (const _event of claudeCode({ sandbox: sandbox(), model: MODEL, maxTurns: 12 })
        .run(h.turn as never)) { /* no-op */ }
    } finally {
      delete process.env["VENDO_LANE_E_BOX_CANARY"];
    }
    const dump = await h.workspace.readFile("/user/files/env.txt");
    console.log("[live box env]", dump.split("\n").map((line) => line.split("=")[0]).filter(Boolean).join(","));
    expect(dump).not.toContain("never-in-a-box");
    expect(dump).not.toContain(process.env["E2B_API_KEY"]);
    expect(dump).toContain("ANTHROPIC_API_KEY");
    // The door credential rides the /session/message payload, never the machine
    // environment — so an agent that dumps its own env cannot read it back out.
    expect(dump).not.toContain("vtk_");
  }, 600_000);
});
