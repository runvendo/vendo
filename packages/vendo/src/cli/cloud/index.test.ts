import { describe, expect, it } from "vitest";
import { runCloud } from "./index.js";

function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, sink: { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) } };
}

describe("cloud command dispatch", () => {
  it("prints cloud help", async () => {
    const messages = output();
    expect(await runCloud(["--help"], { output: messages.sink })).toBe(0);
    expect(messages.logs.join("\n")).toContain("pin-ship --app <id>");
  });

  it("returns one for unknown cloud commands", async () => {
    const messages = output();
    expect(await runCloud(["unknown"], { output: messages.sink })).toBe(1);
    expect(messages.errors.join("\n")).toContain("Unknown cloud command");
  });

  it("dispatches machine-principal commands", async () => {
    const messages = output();
    expect(await runCloud(["validate"], { output: messages.sink, env: {} })).toBe(1);
    expect(messages.errors).toEqual(["Pass --key or set VENDO_API_KEY"]);
  });
});
