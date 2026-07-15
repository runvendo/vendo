import { describe, expect, it } from "vitest";
import { runMcp } from "./index.js";

function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, sink: { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) } };
}

describe("mcp command dispatch", () => {
  it("prints help for the two discovery commands", async () => {
    const messages = output();
    expect(await runMcp(["--help"], { output: messages.sink })).toBe(0);
    expect(messages.logs.join("\n")).toContain("server-json");
    expect(messages.logs.join("\n")).toContain("verify-domain");
  });

  it("returns one for unknown MCP commands", async () => {
    const messages = output();
    expect(await runMcp(["unknown"], { output: messages.sink })).toBe(1);
    expect(messages.errors.join("\n")).toContain("Unknown mcp command");
  });
});
