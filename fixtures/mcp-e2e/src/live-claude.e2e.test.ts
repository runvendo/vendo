import { describe, expect, it } from "vitest";
import { createStack, resetFixture } from "./harness.js";

const LIVE_PORT = 7337;
const LIVE_APPS_PORT = 7338;
const LIVE_TIMEOUT_MS = 5 * 60 * 1000;
const SHIM_URI = "ui://vendo/tree-shim.html";

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

/** ENG-276 live Apps leg: the operator exercises the actual Claude client while
 * the test self-asserts both halves visible to the door — the app-open audit row
 * and a successful resources/read request for the shim HTML. */
describe.skipIf(process.env.VENDO_LIVE_MCP_APPS !== "1")("live Claude MCP Apps ride-along", () => {
  it("observes Claude open the saved app and read its shim resource", async () => {
    await resetFixture();
    const stack = await createStack({ doorPort: LIVE_APPS_PORT });
    try {
      console.log([
        "",
        `Live MCP Apps door: ${stack.endpoint}`,
        `Register: claude mcp add --transport http vendo-apps-e2e ${stack.endpoint}`,
        "Then ask Claude: Open the MCP invoice fixture with vendo_apps_open and render the app.",
        `Waiting for venue='mcp' vendo_apps_open plus resources/read(${SHIM_URI})...`,
        "",
      ].join("\n"));

      const deadline = Date.now() + LIVE_TIMEOUT_MS;
      let openRows: Array<{ tool: string }> = [];
      while (Date.now() < deadline) {
        openRows = await stack.sql<{ tool: string }>(
          "SELECT tool FROM vendo_audit WHERE kind = 'tool-call' AND venue = 'mcp' AND tool = 'vendo_apps_open'",
        );
        if (openRows.length > 0 && stack.resourceReads.includes(SHIM_URI)) break;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }

      expect(openRows).toEqual([{ tool: "vendo_apps_open" }]);
      expect(stack.resourceReads).toContain(SHIM_URI);
      console.log(`Observed live Apps open and shim read: ${SHIM_URI}`);
    } finally {
      await stack.close();
    }
  }, LIVE_TIMEOUT_MS + 60_000);
});
