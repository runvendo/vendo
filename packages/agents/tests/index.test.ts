/** The public surface, pinned — what the spec promises a host can import. */
import { describe, expect, it } from "vitest";
import { claudeCode } from "../src/claude-code.js";
import * as agents from "../src/index.js";
import { mcpSources } from "../src/tools.js";

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

  it("exports both engines, so a host installs one package", () => {
    expect(agents.vendo).toBeTypeOf("function");
    // `claudeCode` rides a subpath, not the barrel: its SDK reaches Node
    // built-ins and this barrel is bundled for Worker targets.
    expect(claudeCode).toBeTypeOf("function");
  });

  it("exports the type a host writes its `system` hook against", () => {
    // Typed from the ROOT: a host that has to reach into a deep path to name the
    // hook it is already passing has no exported contract at all.
    const system: agents.SystemPromptHook = (_ctx, prompt) => prompt.assembled;
    expect(system).toBeTypeOf("function");
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
