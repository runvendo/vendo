/**
 * Contract test for the CopilotKit adapter against the recorded fixture
 * (hand-authored from the AG-UI event schemas — see the fixture's _note).
 * The fixture SSE plays back through the real parse/loop path via the
 * handler seam; no live API calls, ever.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCopilotKitAdapter, type CopilotKitRaw } from "./copilotkit";
import type { HostFixture } from "../runner/types";
import { stubHostFixture } from "../fixtures/stub";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "copilotkit.recorded.json"), "utf8"),
) as { rounds: string[] };

function makeHost(): HostFixture {
  return stubHostFixture("maple", {
    tools: [{ name: "host_listAccounts", description: "List the user's accounts", risk: "low" }],
    execute: vi.fn(async () => [{ id: "a1", name: "Everyday Checking", balance: 4280.12 }]),
  });
}

function handlerFromRounds(rounds: string[]) {
  const requests: unknown[] = [];
  let call = 0;
  const handler = async (req: Request) => {
    requests.push(await req.json());
    const body = rounds[Math.min(call, rounds.length - 1)];
    call += 1;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { handler, requests };
}

describe("copilotkit adapter", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it("returns no-key without ANTHROPIC_API_KEY", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const adapter = createCopilotKitAdapter({ handler: handlerFromRounds(fixture.rounds).handler });
    await expect(adapter.generate("hi", makeHost())).resolves.toEqual({ status: "no-key" });
  });

  it("parses the recorded rounds: executes host tools, records harness intents, captures events", async () => {
    const host = makeHost();
    const { handler, requests } = handlerFromRounds(fixture.rounds);
    const adapter = createCopilotKitAdapter({ handler });
    const result = await adapter.generate("show my account balances at a glance", host);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const raw = result.raw as CopilotKitRaw;

    // Round 1's host tool call was executed against the fixture...
    expect(host.execute).toHaveBeenCalledWith("host_listAccounts", {});
    // ...and its result was fed back as a tool message in round 2's input.
    const round2 = requests[1] as { messages: Array<{ role: string; content?: string }> };
    expect(round2.messages.some((m) => m.role === "tool" && m.content?.includes("Everyday Checking"))).toBe(true);
    // The RunAgentInput carried both harness components and host tools.
    const round1 = requests[0] as { tools: Array<{ name: string }> };
    expect(round1.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["chart", "table", "form", "host_listAccounts"]),
    );

    // Round 2's chart pick became a render intent with parsed props.
    expect(raw.intents).toHaveLength(1);
    expect(raw.intents[0].name).toBe("chart");
    expect(raw.intents[0].props).toMatchObject({ title: "Account balances" });
    expect(raw.text).toContain("balances at a glance");
    // Ordered calls + the full event stream are captured for the drawer.
    expect(raw.toolCalls.map((c) => c.name)).toEqual(["host_listAccounts", "chart"]);
    expect(raw.events.length).toBeGreaterThanOrEqual(10);
  });

  it("never throws: runtime errors become status failed", async () => {
    const adapter = createCopilotKitAdapter({
      handler: async () => new Response("boom", { status: 500 }),
    });
    const result = await adapter.generate("hi", makeHost());
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toContain("copilotkit runtime 500");
  });

  it("treats RUN_ERROR events as failures", async () => {
    const sse = 'data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}\n\ndata: {"type":"RUN_ERROR","message":"model exploded"}\n\n';
    const adapter = createCopilotKitAdapter({ handler: handlerFromRounds([sse]).handler });
    const result = await adapter.generate("hi", makeHost());
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toContain("model exploded");
  });
});
