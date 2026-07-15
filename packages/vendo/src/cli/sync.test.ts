import { afterEach, describe, expect, it, vi } from "vitest";
import { runSync } from "./sync.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const report = (
  breaking: Array<{ tool: string; change: "removed" }> = [],
  changed: string[] = [],
) => ({
  tools: { added: [], removed: [], changed },
  breaking,
  pins: { captured: [], drifted: [] },
  warnings: [],
});

function captureOutput(): { output: { log(message: string): void; error(message: string): void }; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    output: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
    logs,
    errors,
  };
}

describe("vendo sync", () => {
  it("fails soft by default and exits two for strict breaking changes", async () => {
    const output = { log() {}, error() {} };
    const fetchImpl = async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [], automations: [], grants: 0 }],
    }), { status: 200 });
    expect(await runSync({ targetDir: ".", output, sync: async () => { throw new Error("scan"); } })).toBe(0);
    expect(await runSync({ targetDir: ".", strict: true, output, fetchImpl, sync: async () => report([{ tool: "host_x", change: "removed" }]) })).toBe(2);
    expect(await runSync({ targetDir: ".", output, fetchImpl, sync: async () => report([{ tool: "host_x", change: "removed" }]) })).toBe(0);
  });

  it("queries changed and breaking tools and prints per-tool impact", async () => {
    const messages = captureOutput();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [
        {
          tool: "host_x",
          apps: [{ id: "app_x", title: "X" }],
          automations: [{ id: "app_a", title: "A" }, { id: "app_b", title: "B" }],
          grants: 3,
        },
        { tool: "host_y", apps: [], automations: [], grants: 0 },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    await runSync({
      targetDir: ".",
      output: messages.output,
      url: "http://dev.test/api/vendo/",
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }], ["host_x", "host_y"]),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("http://dev.test/api/vendo/sync/impact", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ tools: ["host_x", "host_y"] }),
    });
    expect(messages.logs).toContain("impact: host_x breaks 2 automations, 1 app, 3 grants");
    expect(messages.logs).toContain("impact: host_y no saved references");
  });

  it("falls back when impact is unreachable and keeps strict exit two", async () => {
    const messages = captureOutput();
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); }) as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      strict: true,
      output: messages.output,
      url: "http://offline.test/api/vendo",
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    });

    expect(exit).toBe(2);
    expect(messages.logs).toContain("impact unknown — dev server not reachable at http://offline.test/api/vendo");
  });

  it("returns strict exit three when a breaking tool has nonzero impact", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [], automations: [{ id: "app_a", title: "A" }], grants: 0 }],
    }), { status: 200 })) as typeof fetch;

    await expect(runSync({
      targetDir: ".",
      strict: true,
      output: captureOutput().output,
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    })).resolves.toBe(3);
  });

  it("keeps strict exit two when breaking tools have zero impact", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [], automations: [], grants: 0 }],
    }), { status: 200 })) as typeof fetch;

    await expect(runSync({
      targetDir: ".",
      strict: true,
      output: captureOutput().output,
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    })).resolves.toBe(2);
  });

  it("does not query impact when there are no changed or breaking tools", async () => {
    const fetchImpl = vi.fn() as typeof fetch;

    await expect(runSync({
      targetDir: ".",
      strict: true,
      output: captureOutput().output,
      fetchImpl,
      sync: async () => report(),
    })).resolves.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pushes --report to the Cloud API with key auth", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;

    await expect(runSync({
      targetDir: ".",
      report: true,
      apiKey: "vnd_test",
      apiUrl: "https://cloud.test",
      fetchImpl,
      output: captureOutput().output,
      sync: async () => report(),
    })).resolves.toBe(0);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("https://cloud.test/api/v1/sync/report", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        accept: "application/json",
        authorization: "Bearer vnd_test",
        "content-type": "application/json",
      }),
      body: expect.any(String),
    }));
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ report: report(), at: expect.any(String) });
  });

  it("warns for --report without a key and preserves the strict exit code", async () => {
    vi.stubEnv("VENDO_API_KEY", "");
    const messages = captureOutput();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [], automations: [], grants: 0 }],
    }), { status: 200 })) as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      strict: true,
      report: true,
      output: messages.output,
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    });

    expect(exit).toBe(2);
    expect(messages.errors).toContain("--report requires VENDO_API_KEY or --key");
  });

  it("warns when report push rejects and preserves blast-radius exit three", async () => {
    const messages = captureOutput();
    const push = vi.fn(async () => { throw new Error("cloud offline"); });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [{ id: "app_x", title: "X" }], automations: [], grants: 0 }],
    }), { status: 200 })) as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      strict: true,
      report: true,
      apiKey: "vnd_test",
      output: messages.output,
      fetchImpl,
      push,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    });

    expect(exit).toBe(3);
    expect(push).toHaveBeenCalledWith({ report: report([{ tool: "host_x", change: "removed" }]), impact: [
      { tool: "host_x", apps: [{ id: "app_x", title: "X" }], automations: [], grants: 0 },
    ], at: expect.any(String) });
    expect(messages.errors).toContain("warning: failed to push sync report: cloud offline");
  });

  it("--json prints exactly one machine-readable object carrying report and impact", async () => {
    const messages = captureOutput();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [], automations: [{ id: "app_a", title: "A" }], grants: 0 }],
    }), { status: 200 })) as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      json: true,
      output: messages.output,
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }], ["host_x"]),
    });

    expect(exit).toBe(0);
    expect(messages.logs).toHaveLength(1);
    expect(messages.errors).toHaveLength(0);
    expect(JSON.parse(messages.logs[0]!)).toEqual({
      ok: true,
      exitCode: 0,
      report: report([{ tool: "host_x", change: "removed" }], ["host_x"]),
      impact: [{ tool: "host_x", apps: [], automations: [{ id: "app_a", title: "A" }], grants: 0 }],
      notes: [],
    });
  });

  it("--json keeps strict exit codes and surfaces unknown impact as null plus a note", async () => {
    const messages = captureOutput();
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); }) as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      strict: true,
      json: true,
      output: messages.output,
      url: "http://offline.test/api/vendo",
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    });

    expect(exit).toBe(2);
    expect(messages.logs).toHaveLength(1);
    expect(messages.errors).toHaveLength(0);
    expect(JSON.parse(messages.logs[0]!)).toMatchObject({
      ok: false,
      exitCode: 2,
      impact: null,
      notes: ["impact unknown — dev server not reachable at http://offline.test/api/vendo"],
    });
  });

  it("--json reports an empty impact when nothing changed and collects report-push notes", async () => {
    vi.stubEnv("VENDO_API_KEY", "");
    const messages = captureOutput();
    const fetchImpl = vi.fn() as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      json: true,
      report: true,
      output: messages.output,
      fetchImpl,
      sync: async () => report(),
    });

    expect(exit).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(messages.errors).toHaveLength(0);
    expect(JSON.parse(messages.logs[0]!)).toMatchObject({
      ok: true,
      exitCode: 0,
      impact: [],
      notes: ["--report requires VENDO_API_KEY or --key"],
    });
  });

  it("--json emits a parseable envelope when extraction itself fails soft", async () => {
    const soft = captureOutput();
    expect(await runSync({
      targetDir: ".",
      json: true,
      output: soft.output,
      sync: async () => { throw new Error("scan"); },
    })).toBe(0);
    expect(soft.errors).toHaveLength(0);
    expect(JSON.parse(soft.logs[0]!)).toMatchObject({
      ok: true,
      exitCode: 0,
      impact: null,
      error: "sync failed soft: scan",
    });

    const strict = captureOutput();
    expect(await runSync({
      targetDir: ".",
      strict: true,
      json: true,
      output: strict.output,
      sync: async () => { throw new Error("scan"); },
    })).toBe(2);
    expect(JSON.parse(strict.logs[0]!)).toMatchObject({ ok: false, exitCode: 2, error: "sync failed soft: scan" });
  });
});
