/**
 * Wire-safety regression for the scripted turn engine: every dynamic tool part
 * a scripted beat streams (and persists) must replay cleanly through the REAL
 * agent later — the runtime feeds thread history to Anthropic via
 * `convertToModelMessages`, and the wire requires `tool_use.input` to be an
 * OBJECT. A string input (the standing-grant ask's consent sentence riding as
 * `input`) 400s the first real prompt sent in the same thread:
 * `tool_use.input: Input should be an object`.
 */
import type { ApprovalRequest } from "@vendoai/core";
import { convertToModelMessages, type UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

function ask(id: string, tool: string, name: string, appKey: string): ApprovalRequest {
  return {
    id: id as ApprovalRequest["id"],
    call: { id: `call_${id}`, tool, args: {} },
    descriptor: {
      name: tool,
      description: `Descriptor for ${tool}.`,
      inputSchema: {},
      risk: "read",
    },
    inputPreview: `Allow "${name}" to use ${tool} while you're away (standing, this app only)`,
    ctx: {
      principal: { kind: "user", subject: "vendo-demo" },
      venue: "automation",
      presence: "present",
      appId: `app_demo_${appKey}_vendo-demo`,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const grantAsk = ask("apr_test_1", "host_listAccounts", "Low balance alert", "lowbalance");
const weeklyAsks = [
  ask("apr_weekly_1", "host_getSpendingInsights", "Weekly spending summary", "weekly"),
  ask("apr_weekly_2", "host_listTransactions", "Weekly spending summary", "weekly"),
];

vi.mock("@/vendo/server", () => ({
  vendo: {
    guardedTools: {
      execute: vi.fn(async () => ({
        status: "ok",
        output: { data: [{ kind: "checking", balance: 921220 }] },
      })),
    },
    automations: {
      enable: vi.fn(async (appId: string) => appId.includes("weekly")
        ? { enabled: true, missing: weeklyAsks, grantSetId: "gset_weekly_test" }
        : { enabled: true, missing: [grantAsk], grantSetId: "gset_lowbalance_test" }),
      list: vi.fn(async () => []),
    },
    apps: {
      get: vi.fn(async () => ({
        id: "app_demo_lowbalance_vendo-demo",
        name: "Low balance alert",
        description: "Email an alert when checking dips below $2,000.",
        trigger: undefined,
      })),
      open: vi.fn(async () => ({ kind: "iframe" })),
    },
    connections: { list: vi.fn(async () => []) },
    guard: { approvals: { pending: vi.fn(async () => []), decide: vi.fn(async () => undefined) } },
    store: { records: () => ({ get: vi.fn(async () => null) }) },
  },
}));

vi.mock("@/vendo/auth", () => ({
  resolveMapleSession: vi.fn(async () => ({
    subject: "vendo-demo",
    display: "Vendo Demo",
    email: "yousef@maple.com",
  })),
}));

const threadState = vi.hoisted(() => ({
  messages: [] as unknown[],
  persisted: [] as unknown[],
}));

/** The scenario ladder is host copy: cards get added, dropped and reordered.
 *  `reversed` serves the SAME cards in a different order (which must not
 *  change which script a card plays); `dropped` removes one card entirely;
 *  `collided` prepends a transfer card carrying the spending card's prompt
 *  (padded with whitespace, so it trims to the same routing key) — the
 *  duplicate that would hand the choice of script back to ladder order. */
const scenarioLadder = vi.hoisted(() => ({ reversed: false, dropped: "", collided: false }));

vi.mock("@/vendo/scenarios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/vendo/scenarios")>();
  const card = (beat: string): (typeof actual.mapleScenarios)[number] => {
    const found = actual.mapleScenarios.find((candidate) => candidate.beat === beat);
    if (found === undefined) throw new Error(`no Maple scenario card declares beat "${beat}"`);
    return found;
  };
  return {
    ...actual,
    get mapleScenarios() {
      const cards = actual.mapleScenarios.filter((candidate) => candidate.beat !== scenarioLadder.dropped);
      const ladder = scenarioLadder.reversed ? [...cards].reverse() : cards;
      if (!scenarioLadder.collided) return ladder;
      return [{ ...card("transfer"), prompt: `  ${card("spending").prompt}  ` }, ...ladder];
    },
  };
});

vi.mock("../../src/demo-script/threads", () => ({
  loadScriptedThread: vi.fn(async () => ({ id: "thr_test", messages: threadState.messages as UIMessage[] })),
  persistScriptedThread: vi.fn(async (_principal: unknown, _id: unknown, messages: unknown[]) => {
    threadState.persisted = messages;
  }),
  upsertMessage: (messages: UIMessage[], message: UIMessage) => {
    messages.push(message);
  },
}));

import { mapleScenarios } from "@/vendo/scenarios";
import { scriptedThreadsResponse } from "../../src/demo-script/engine";

/** The prompt a card sends on tap, found by its headline — never by position. */
function cardPrompt(title: string): string {
  const card = mapleScenarios.find((candidate) => candidate.title === title);
  if (card === undefined) throw new Error(`no Maple scenario card titled "${title}"`);
  return (card.prompt ?? card.title).trim();
}

function threadsRequest(text: string): Request {
  return new Request("http://localhost:3000/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: { id: "msg_user_1", role: "user", parts: [{ type: "text", text }] },
    }),
  });
}

async function streamedChunks(response: Response): Promise<Array<Record<string, unknown>>> {
  const body = await response.text();
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

describe("scripted beats stream wire-safe tool parts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadState.messages = [];
    threadState.persisted = [];
    scenarioLadder.reversed = false;
    scenarioLadder.dropped = "";
    scenarioLadder.collided = false;
  });

  it("the low-balance beat streams every tool input as an object (Anthropic replay contract)", async () => {
    const response = await scriptedThreadsResponse(
      threadsRequest("When my checking balance drops below $2,000, email me an alert."),
    );
    expect(response).not.toBeNull();
    const chunks = await streamedChunks(response as Response);

    const inputChunks = chunks.filter((chunk) => chunk.type === "tool-input-available");
    // The beat streams at least the balance read and the standing-grant ask.
    expect(inputChunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of inputChunks) {
      expect(
        typeof chunk.input === "object" && chunk.input !== null && !Array.isArray(chunk.input),
        `tool_use.input must be an object for wire replay, got: ${JSON.stringify(chunk.input)}`,
      ).toBe(true);
    }

    // Outputs must be objects too (tool_result content on replay).
    for (const chunk of chunks.filter((c) => c.type === "tool-output-available")) {
      expect(typeof chunk.output === "object" && chunk.output !== null).toBe(true);
    }

    // The consent sentence still reaches the card — as a field of the input
    // object, never as a bare-string input.
    const grantInput = inputChunks.at(-1)?.input as Record<string, unknown>;
    expect(JSON.stringify(grantInput)).toContain("standing, this app only");
  }, 60_000);

  it("the weekly beat surfaces the WHOLE grant set as one data-vendo-grant-set part (criterion 22, demo half)", async () => {
    const response = await scriptedThreadsResponse(
      threadsRequest("Every Friday, email me a summary of that week's spending."),
    );
    expect(response).not.toBeNull();
    const chunks = await streamedChunks(response as Response);

    // The whole set rides ONE part — never a missing[0] drip.
    const setParts = chunks.filter((chunk) => chunk.type === "data-vendo-grant-set");
    expect(setParts).toHaveLength(1);
    const data = setParts[0]!.data as {
      toolCallId: string;
      grantSetId: string;
      permissions: Array<{ approvalId: string; tool: string }>;
    };
    expect(data.grantSetId).toBe("gset_weekly_test");
    expect(data.permissions.map((permission) => permission.approvalId)).toEqual(["apr_weekly_1", "apr_weekly_2"]);
    expect(data.permissions.map((permission) => permission.tool)).toEqual([
      "host_getSpendingInsights",
      "host_listTransactions",
    ]);
    // Exactly one parked native call carries the set (the first ask's id).
    const parks = chunks.filter((chunk) => chunk.type === "tool-approval-request");
    expect(parks).toHaveLength(1);
    expect(parks[0]).toMatchObject({ approvalId: "apr_weekly_1", toolCallId: data.toolCallId });
    // No legacy single-ask approval part for grant asks.
    expect(chunks.filter((chunk) => chunk.type === "data-vendo-approval")).toHaveLength(0);
  }, 60_000);

  it("every card still plays its OWN script when the scenario ladder is reordered", async () => {
    scenarioLadder.reversed = true;
    const turn = async (title: string): Promise<{ tools: string[]; text: string }> => {
      const response = await scriptedThreadsResponse(threadsRequest(cardPrompt(title)));
      expect(response, `"${title}" matched no scripted beat`).not.toBeNull();
      const chunks = await streamedChunks(response as Response);
      return {
        tools: chunks.filter((chunk) => chunk.type === "tool-input-start").map((chunk) => String(chunk.toolName)),
        text: chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => String(chunk.delta)).join(""),
      };
    };

    const [spending, transfer, weekly, moneyHq, lowBalance] = await Promise.all([
      turn("Where did my money go?"),
      turn("Move money to savings"),
      turn("Email me a weekly summary"),
      turn("Build my money HQ"),
      turn("Alert me before I overdraft"),
    ]);

    expect(spending.text).toContain("Here's where this month went.");
    expect(transfer.tools).toContain("host_transferMoney");
    expect(weekly.text).toContain("Setting up your Friday digest");
    expect(moneyHq.text).toContain("Here's your money HQ");
    expect(lowBalance.text).toContain("You want a heads-up before checking runs low.");
  }, 120_000);

  it("a beat left without a card fails at import, naming the beat", async () => {
    scenarioLadder.dropped = "moneyhq";
    vi.resetModules();
    await expect(import("../../src/demo-script/engine.js")).rejects.toThrow(/moneyhq/);
  });

  it("two cards sharing a prompt fail at import, naming both beats", async () => {
    scenarioLadder.collided = true;
    vi.resetModules();
    const error = await import("../../src/demo-script/engine.js").then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );
    expect(error, "a duplicate prompt must not boot — first match would decide the script").toBeDefined();
    expect(error?.message).toContain("transfer");
    expect(error?.message).toContain("spending");
    expect(error?.message).toContain(cardPrompt("Where did my money go?"));
    expect(error?.message).toContain("src/vendo/scenarios.tsx");
  });

  it("a parked set abandoned by the next prompt resolves non-orphan — real-agent replay never 400s (criterion 23)", async () => {
    // History: a weekly turn parked on its grant set, never decided.
    threadState.messages = [
      { id: "msg_u1", role: "user", parts: [{ type: "text", text: "Every Friday, email me a summary of that week's spending." }] },
      {
        id: "msg_a1",
        role: "assistant",
        parts: [
          { type: "text", text: "It needs two standing permissions.", state: "done" },
          {
            type: "dynamic-tool",
            toolName: "host_getSpendingInsights",
            toolCallId: "mds_grant_weekly_abc12345",
            state: "approval-requested",
            input: { permissions: ["preview one", "preview two"] },
            approval: { id: "apr_weekly_1" },
          },
        ],
      },
    ];

    // The next scripted prompt arrives before any decision.
    const response = await scriptedThreadsResponse(
      threadsRequest("Where did my money go this month? Build me a spending breakdown I can keep."),
    );
    expect(response).not.toBeNull();
    await (response as Response).text(); // drain so onFinish persists

    const persisted = threadState.persisted as UIMessage[];
    expect(persisted.length).toBeGreaterThanOrEqual(3);
    const parked = persisted
      .flatMap((message) => message.parts)
      .find((part) => (part as { toolCallId?: string }).toolCallId === "mds_grant_weekly_abc12345") as
        { state?: string } | undefined;
    expect(parked?.state).toBe("output-denied");

    // THE contract: the exact input the real agent replays produces no orphan
    // tool_use (every tool-call has a matching tool-result).
    const model = await convertToModelMessages(persisted);
    const calls: string[] = [];
    const results: string[] = [];
    for (const message of model) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === "tool-call") calls.push(block.toolCallId);
        if (block.type === "tool-result") results.push(block.toolCallId);
      }
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((id) => !results.includes(id))).toEqual([]);
  }, 60_000);
});
