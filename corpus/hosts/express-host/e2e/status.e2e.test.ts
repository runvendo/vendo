import { describe, expect, it } from "vitest";
import { scriptedModel, startTestHost, textTurn } from "./harness.js";

describe("Relay Vendo status over Express", () => {
  it("returns the composed posture, version, and blocks over real HTTP", async () => {
    const host = await startTestHost(scriptedModel([textTurn("unused")]));
    try {
      const response = await fetch(`${host.baseUrl}/api/vendo/status`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        posture: "rules",
        version: expect.any(String),
        blocks: {
          store: true,
          agent: true,
          actions: true,
          guard: true,
          apps: true,
          automations: true,
          mcp: false,
          sandbox: false,
          // The harness passes an explicit scripted model → "custom" venue.
          model: "custom",
          // 04-actions §3 — no BYO connector and no VENDO_API_KEY → no broker.
          connections: false,
        },
      });
    } finally {
      await host.close();
    }
  });
});
