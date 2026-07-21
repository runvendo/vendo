import { describe, expect, it, vi } from "vitest";
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
    expect(messages.logs.join("\n")).toContain("login EMAIL");
    expect(messages.logs.join("\n")).not.toContain("validate");
    // The retired machine trio is gone from the surface entirely, and so is
    // the deployments read (its org-scoped endpoint died with spine v2 and
    // the console Deployments page was removed 2026-07-21).
    for (const removed of ["share", "publish", "pin-ship", "deployments"]) {
      expect(messages.logs.join("\n")).not.toContain(removed);
    }
    expect(messages.logs.join("\n")).not.toMatch(/\bdeploy\b/);
  });

  it("help leads with the ceremony and demotes email OTP to a fallback", async () => {
    const messages = output();
    expect(await runCloud(["--help"], { output: messages.sink })).toBe(0);
    const help = messages.logs.join("\n");
    expect(help.indexOf("device-login")).toBeLessThan(help.indexOf("login EMAIL"));
    expect(help).toContain("alias of `vendo login`");
    expect(help).toContain("Fallback");
  });

  it("returns one for unknown cloud commands", async () => {
    const messages = output();
    expect(await runCloud(["unknown"], { output: messages.sink })).toBe(1);
    expect(messages.errors.join("\n")).toContain("Unknown cloud command");
  });

  it("rejects the removed commands: validate, share, publish, pin-ship", async () => {
    for (const removed of ["validate", "share", "publish", "pin-ship"]) {
      const messages = output();
      expect(await runCloud([removed], { output: messages.sink, env: {} })).toBe(1);
      expect(messages.errors.join("\n")).toContain("Unknown cloud command");
    }
  });

  it("rejects the removed deploy command", async () => {
    const messages = output();
    expect(await runCloud(["deploy", "--key", "vnd_test"], { output: messages.sink, env: {} })).toBe(1);
    expect(messages.errors.join("\n")).toContain("Unknown cloud command");
  });
});
