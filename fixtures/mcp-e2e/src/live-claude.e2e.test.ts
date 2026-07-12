import { describe, expect, it } from "vitest";
import { createStack, resetFixture } from "./harness.js";

const LIVE_PORT = 7337;
const LIVE_TIMEOUT_MS = 5 * 60 * 1000;

/** Live leg (10-mcp §6, env-gated): holds a real door on a fixed port while
 * the operator connects Claude Code itself (`claude mcp add`) and runs one
 * real tool call. The test self-asserts by polling the audit table for the
 * door-side evidence: a venue='mcp' tool-call row from the bound registry. */
describe.skipIf(process.env.VENDO_LIVE_MCP !== "1")("live Claude MCP registration", () => {
  it("serves a local door and observes a real Claude tool call in the audit log", async () => {
    await resetFixture();
    const stack = await createStack({ doorPort: LIVE_PORT });
    try {
      console.log([
        "",
        `Live MCP door: ${stack.endpoint}`,
        `Register: claude mcp add --transport http vendo-e2e ${stack.endpoint}`,
        "Waiting for a venue='mcp' tool-call audit row from a host_* tool...",
        "",
      ].join("\n"));
      const deadline = Date.now() + LIVE_TIMEOUT_MS;
      let rows: Array<{ tool: string }> = [];
      while (Date.now() < deadline && rows.length === 0) {
        rows = await stack.sql<{ tool: string }>(
          "SELECT tool FROM vendo_audit WHERE kind = 'tool-call' AND venue = 'mcp' AND tool LIKE 'host_%'",
        );
        if (rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      expect(rows.length).toBeGreaterThan(0);
      console.log(`Observed live door tool call(s): ${rows.map((row) => row.tool).join(", ")}`);
    } finally {
      await stack.close();
    }
  }, LIVE_TIMEOUT_MS + 60_000);
});
