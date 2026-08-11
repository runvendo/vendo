/**
 * The live proof for `claudeCode()` — a REAL Claude Agent SDK, real bash hands
 * over a real materialized workspace, our real guard seam.
 *
 * Gated on `ANTHROPIC_API_KEY`, like every other `.live.test.ts` in the repo:
 * skipped without it, so CI and a keyless clone stay green.
 *
 * `machine: "local"` on purpose. The sandbox path adds an e2b machine and a
 * control-port hop and changes NOTHING above the `SessionMachine` port — the
 * permission hook, the diff sync-back and `turn.state` are the same code either
 * way, and this is the leg that can be proven without a provider account or a
 * template bake.
 *
 * **door-ctx moved the TOOL proofs out of this file.** A `claudeCode()` turn
 * reaches its tools through the host's MCP door now, and a door needs a composed
 * host — which this package cannot build (layering: harnesses never depends on
 * the umbrella). The three asks that were about tools therefore live where the
 * composition does:
 *
 *   - `packages/vendo/src/claude-code-composed.live.test.ts` — the local leg,
 *     over a real loopback door;
 *   - `docs/verification/door-ctx/live-door-proof.mjs` — the box leg, over a
 *     real public tunnel, with the approval tap and the audit rows;
 *   - `packages/vendo/src/mcp-door-parity.e2e.test.ts` — the offline gate.
 *
 * What stays here is everything that is TRUE of the harness with no door at all:
 * its real bash hands, the diff sync-back, the native session across turns, and
 * an honest refusal.
 */
import type { Json, ToolResult, Turn } from "@vendoai/core";
import { describe, expect, test } from "vitest";
import { createTurnState } from "../../src/harness-state.js";
import { testWorkspace, unusedModels, userMessage } from "../../src/test-doubles.test-util.js";
import { claudeCode } from "../../src/claude-code/index.js";

const live = process.env["ANTHROPIC_API_KEY"] === undefined ? describe.skip : describe;
const MODEL = process.env["VENDO_LIVE_MODEL"] ?? "claude-sonnet-4-5";

interface Harnessed {
  turn: Turn<never>;
  workspace: ReturnType<typeof testWorkspace>;
  calls: Array<{ name: string; args: Json }>;
  state: ReturnType<typeof createTurnState>;
}

function harnessed(input: {
  say: string;
  files?: Record<string, string>;
  tools?: Array<{ name: string; title: string; description: string; inputSchema?: Json }>;
  answer?: (name: string, args: Json) => ToolResult;
  state?: string;
  thread?: string;
  /** The transcript SO FAR — see the note on `messages` below. */
  history?: Array<{ id: string; role: "user" | "assistant"; text: string }>;
}): Harnessed {
  const workspace = testWorkspace(input.files ?? {});
  const calls: Array<{ name: string; args: Json }> = [];
  const state = createTurnState(input.state);
  const turn = {
    messages: [
      // `Turn.messages` is the canonical transcript the runtime reads back and
      // upserts the new message into (`packages/vendo/src/harness-turn.ts`), so a
      // real turn 2 carries turn 1 AND its reply. A double that hands one message
      // per turn makes a genuine next message look like a TRUNCATION.
      ...(input.history ?? []).map(({ id, role, text }) => (
        role === "user"
          ? userMessage(id, text)
          : { id, role: "assistant" as const, parts: [{ type: "text" as const, text }] }
      )),
      userMessage(input.thread ?? `m_${Math.random().toString(36).slice(2)}`, input.say),
    ],
    tools: {
      list: async () => (input.tools ?? []).map((tool) => ({ ...tool, risk: "read" as const })),
      call: async (name: string, args: Json) => {
        calls.push({ name, args });
        return input.answer?.(name, args) ?? { status: "ok" as const, output: { ok: true } };
      },
    },
    skills: { list: async () => [], load: async () => "" },
    workspace,
    models: unusedModels(),
    state,
    options: {} as never,
    signal: AbortSignal.timeout(240_000),
    interactive: true,
    system: "You are the assistant inside Maple, a small business banking product.",
  } as unknown as Turn<never>;
  return { turn, workspace, calls, state };
}

async function say(h: Harnessed, options: Record<string, unknown> = {}): Promise<string> {
  const harness = claudeCode({ machine: "local", model: MODEL, maxTurns: 12, ...options });
  let text = "";
  for await (const event of harness.run(h.turn as never)) {
    if (event.type === "text") text += event.delta;
    if (event.type === "error") text += `\n[error] ${event.message}`;
  }
  return text;
}

live("claudeCode() — live, machine:\"local\"", () => {
  test("E1 · edit-in-place: the box's real bash edits the app, and the DIFF lands in the store", async () => {
    const h = harnessed({
      say: "The dashboard heading says 'Invoices'. Change it to say 'Bills' and nothing else.",
      files: {
        "/user/apps/app_live/app.vendo": '<App name="Money">\n  <Heading text="Invoices" />\n</App>\n',
      },
    });
    const reply = await say(h);
    const after = await h.workspace.readFile("/user/apps/app_live/app.vendo");
    console.log("[live E1 edit]", JSON.stringify({ reply, after, commits: h.workspace.commits }));
    expect(after).toContain("Bills");
    expect(after).not.toContain("Invoices");
    // Diff-based, never wholesale: exactly one file changed.
    expect(h.workspace.commits.flatMap((commit) => commit.changed)).toEqual([
      "/user/apps/app_live/app.vendo",
    ]);
  }, 300_000);

  test("E1 · an impossible ask is refused honestly, with no invented tool", async () => {
    const h = harnessed({
      say: "Book me a flight to Tokyo for tomorrow morning.",
      tools: [{
        name: "maple_invoices_list",
        title: "List invoices",
        description: "List the signed-in user's invoices.",
      }],
    });
    const reply = await say(h);
    console.log("[live E1 impossible]", JSON.stringify({ reply, calls: h.calls }));
    expect(h.calls).toEqual([]);
    expect(reply.toLowerCase()).toMatch(/can'?t|cannot|not able|don'?t have|unable/);
  }, 300_000);

  test("§1.3 · turn.state carries the native session, and the next turn RESUMES it", async () => {
    const first = harnessed({ say: "Remember the number 4127. Just say ok.", thread: "m_live_session" });
    await say(first);
    const carried = first.state.pending().value;
    console.log("[live session]", JSON.stringify({ carried }));
    expect(carried).toBeDefined();
    expect(JSON.parse(carried!).sessionId).toMatch(/.+/);

    const second = harnessed({
      // The transcript so far, as the runtime supplies it: this is an APPEND, so
      // the live session is kept rather than dropped for a truncation.
      history: [
        { id: "m_live_session", role: "user", text: "Remember the number 4127. Just say ok." },
        { id: "a_live_session", role: "assistant", text: "ok" },
      ],
      say: "What number did I ask you to remember? Reply with digits only.",
      thread: "m_live_session_2",
      state: carried!,
    });
    const reply = await say(second);
    console.log("[live session resume]", JSON.stringify({ reply }));
    expect(reply).toContain("4127");
  }, 420_000);

});
