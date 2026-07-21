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
    expect(messages.logs.join("\n")).toContain("deploy [--app <id>] [--secret NAME=VALUE]");
    expect(messages.logs.join("\n")).not.toContain("validate");
    // The retired machine trio is gone from the surface entirely.
    for (const removed of ["share", "publish", "pin-ship"]) {
      expect(messages.logs.join("\n")).not.toContain(removed);
    }
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

  it("dispatches deploy with the machine principal", async () => {
    const messages = output();
    const fetcher = vi.fn().mockResolvedValue({
      org: { id: "org_1", slug: "acme" },
      instance: { status: "active" },
      applied: { apps: 1, grants: 0, secrets: 0 },
      webhooks: [],
    });
    const localProjectReader = vi.fn().mockResolvedValue({
      subject: "user_a",
      apps: [{
        enabled: true,
        doc: {
          format: "vendo/app@1",
          id: "app_auto",
          name: "Automation",
          trigger: {
            on: { kind: "schedule", every: "1h" },
            run: { kind: "steps", steps: [] },
          },
        },
      }],
      grants: [],
    });

    expect(await runCloud(["deploy", "--key", "vnd_test", "--json"], {
      output: messages.sink,
      env: {},
      fetcher,
      localProjectReader,
    })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/hosted/deploy", expect.objectContaining({
      auth: "key",
      apiKey: "vnd_test",
    }));
  });
});
