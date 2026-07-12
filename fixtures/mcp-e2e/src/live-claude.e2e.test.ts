import { describe, expect, it } from "vitest";
import { createStack, resetFixture } from "./harness.js";

const LIVE_PORT = 7337;

describe.skipIf(process.env.VENDO_LIVE_MCP !== "1")("live Claude MCP registration", () => {
  it("serves a fixed local door for the manual Claude leg", async () => {
    await resetFixture();
    const stack = await createStack({ doorPort: LIVE_PORT });
    try {
      const command = `claude mcp add --transport http vendo-e2e ${stack.endpoint}`;
      console.log(`\nLive MCP door: ${stack.endpoint}\nRun: ${command}\n`);
      expect(stack.endpoint).toBe(`http://127.0.0.1:${LIVE_PORT}/api/vendo/mcp`);
    } finally {
      await stack.close();
    }
  });
});
