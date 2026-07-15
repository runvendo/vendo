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
    expect(messages.logs.join("\n")).toContain("pin-ship --app <id>");
    expect(messages.logs.join("\n")).toContain("login EMAIL");
    expect(messages.logs.join("\n")).toContain("deploy [--app <id>] [--secret NAME=VALUE]");
    expect(messages.logs.join("\n")).toContain("validate [--json]                     Validate a key and show plan, capabilities, and quota");
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
