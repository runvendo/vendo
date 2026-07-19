import { describe, expect, it } from "vitest";
import { agentEnv, buildClaudeArgs } from "./agent.js";

describe("buildClaudeArgs", () => {
  it("builds a headless stream-json invocation with budget and model", () => {
    const args = buildClaudeArgs({ prompt: "Install Vendo in this repo.", model: "haiku", maxBudgetUsd: 2.5 });
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("Install Vendo in this repo.");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("bypassPermissions");
    expect(args).toContain("--no-session-persistence");
    // User-level CLAUDE.md/skills stay out of the measurement.
    const settingSources = args[args.indexOf("--setting-sources") + 1];
    expect(settingSources).toBe("project");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2.5");
  });
});

describe("agentEnv", () => {
  it("drops VENDO_API_KEY so a machine key cannot skip the account ask", () => {
    const env = agentEnv({ PATH: "/bin", VENDO_API_KEY: "sk-vendo-x", ANTHROPIC_API_KEY: "sk-ant-y" });
    expect(env["VENDO_API_KEY"]).toBeUndefined();
    expect(env["PATH"]).toBe("/bin");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-y");
  });
});
