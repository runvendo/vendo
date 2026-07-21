import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runMcp } from "./index.js";
import { telemetryCapture } from "../telemetry.test-util.js";

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

describe("mcp telemetry", () => {
  it("tracks command_run mcp; help exits before any tracking", async () => {
    const help = await telemetryCapture();
    expect(await runMcp(["--help"], { output: output().sink, telemetry: help.telemetry })).toBe(0);
    expect(help.events()).toEqual([]);

    const failed = await telemetryCapture();
    expect(await runMcp(["unknown"], { output: output().sink, telemetry: failed.telemetry })).toBe(1);
    expect(failed.event("command_run").properties).toMatchObject({
      command: "mcp",
      ok: false,
      failedStep: "unknown-command",
    });
    await rm(help.home, { recursive: true, force: true });
    await rm(failed.home, { recursive: true, force: true });
  });
});
