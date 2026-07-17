import { describe, expect, it } from "vitest";
import { ClaudeSessionRider } from "./claude.js";
import { CodexSessionRider } from "./codex.js";
import type { RiderSession } from "./types.js";

/**
 * Live rider verification (ENG-338 E2E step): rides the REAL authed CLI
 * sessions on this machine. Skipped unless VENDO_LIVE_RIDERS=1.
 *
 * - claude rung additionally needs VENDO_LIVE_SDK_ROOT pointing at a directory
 *   whose node_modules contains @anthropic-ai/claude-agent-sdk (the host-app
 *   stand-in; the repo itself deliberately does not depend on the SDK).
 * - codex rung needs `codex` on PATH with a completed `codex login`.
 */

const live = process.env.VENDO_LIVE_RIDERS === "1";
const sdkRoot = process.env.VENDO_LIVE_SDK_ROOT;

const BALANCE_TOOL = {
  name: "vendo_get_balance",
  description: "Get the user's current account balance in dollars (read-only).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

async function toolRoundTrip(rider: RiderSession, approvalParkMs = 0): Promise<{ calls: number; answer: string }> {
  let calls = 0;
  try {
    await rider.start({
      system: "You are Vendo's embedded product agent for a demo bank. Only use the provided vendo tools. Answer in one short sentence.",
      tools: [BALANCE_TOOL],
      onToolCall: async () => {
        calls += 1;
        if (approvalParkMs > 0) await new Promise((resolve) => setTimeout(resolve, approvalParkMs));
        return { text: JSON.stringify({ status: "ok", output: { balanceDollars: 4321.09 } }), ok: true };
      },
    });
    const result = await rider.runTurn("What is my current balance? Use the tool.", () => {});
    return { calls, answer: result.text };
  } finally {
    await rider.dispose();
  }
}

describe.skipIf(!live)("live riders (VENDO_LIVE_RIDERS=1)", () => {
  it.skipIf(!sdkRoot)("claude session: rides the login, executes a bridged tool through a parked executor", async () => {
    const rider = new ClaudeSessionRider({ root: sdkRoot! });
    const { calls, answer } = await toolRoundTrip(rider, 2_000);
    console.log(`[live claude] model=${rider.model} calls=${calls} answer=${JSON.stringify(answer)}`);
    expect(calls).toBe(1);
    expect(answer.replace(/,/g, "")).toContain("4321");
  }, 180_000);

  it("codex session: rides the login, executes a bridged dynamic tool through a parked executor", async () => {
    const rider = new CodexSessionRider();
    const { calls, answer } = await toolRoundTrip(rider, 2_000);
    console.log(`[live codex] model=${rider.model} calls=${calls} answer=${JSON.stringify(answer)}`);
    expect(calls).toBe(1);
    expect(answer.replace(/,/g, "")).toContain("4321");
  }, 180_000);
});
