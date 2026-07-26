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
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const grantAsk: ApprovalRequest = {
  id: "apr_test_1" as ApprovalRequest["id"],
  call: { id: "call_test_1", tool: "host_listAccounts", args: {} },
  descriptor: {
    name: "host_listAccounts",
    description: "List the user's bank accounts with balances.",
    inputSchema: {},
    risk: "read",
  },
  inputPreview:
    'Allow "Low balance alert" to use host_listAccounts while you\'re away (standing, this app only)',
  ctx: {
    principal: { kind: "user", subject: "vendo-demo" },
    venue: "automation",
    presence: "present",
    appId: "app_demo_lowbalance_vendo-demo",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
};

vi.mock("@/vendo/server", () => ({
  vendo: {
    guardedTools: {
      execute: vi.fn(async () => ({
        status: "ok",
        output: { data: [{ kind: "checking", balance: 921220 }] },
      })),
    },
    automations: {
      enable: vi.fn(async () => ({ enabled: true, missing: [grantAsk] })),
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

vi.mock("./threads", () => ({
  loadScriptedThread: vi.fn(async () => ({ id: "thr_test", messages: [] })),
  persistScriptedThread: vi.fn(async () => undefined),
  upsertMessage: (messages: UIMessage[], message: UIMessage) => {
    messages.push(message);
  },
}));

import { scriptedThreadsResponse } from "./engine";

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
  });

  it("card (e) low-balance beat: every tool input is an object (Anthropic replay contract)", async () => {
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
});
