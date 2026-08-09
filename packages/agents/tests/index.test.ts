/** The public surface, pinned — what the spec promises a host can import. */
import { describe, expect, it } from "vitest";
import * as agents from "../src/index.js";
import * as harnesses from "../src/harnesses.js";
import { mcpSources } from "../src/mcp.js";

describe("the package surface", () => {
  it("exports the spec's API from the root", () => {
    expect(agents.agent).toBeTypeOf("function");
    expect(agents.tool).toBeTypeOf("function");
    expect(agents.api).toBeTypeOf("function");
    expect(agents.createGuard).toBeTypeOf("function");
    expect(agents.e2b).toBeTypeOf("function");
    expect(agents.postgres).toBeTypeOf("function");
    expect(agents.provideCloudAdapters).toBeTypeOf("function");
  });

  it("exports the harness factories from ./harnesses", () => {
    expect(harnesses.claudeCode).toBeTypeOf("function");
    expect(harnesses.vendo).toBeTypeOf("function");
  });
});

describe("mcp sources", () => {
  it("turns { url, headers } configs into named connectors", () => {
    const [shared, perUser] = mcpSources([
      { url: "https://mcp.example.com", headers: { authorization: "shared" } },
      { url: "https://mcp.example.com", name: "crm", headers: async () => ({ authorization: "minted" }) },
    ]);
    expect(shared?.name).toBe("mcp");
    expect(perUser?.name).toBe("crm");
    expect(shared?.descriptors).toBeTypeOf("function");
    expect(shared?.execute).toBeTypeOf("function");
  });
});
