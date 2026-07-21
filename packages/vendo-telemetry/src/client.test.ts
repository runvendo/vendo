import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetry } from "./client.js";

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    version: "9.9.9",
    home: undefined as string | undefined,
    config: { anonymousId: "id-1", optedOut: false, noticeShown: true },
    env: {} as Record<string, string | undefined>,
    runtime: false,
    posthogKey: "phc_test",
    fetchImpl: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

describe("createTelemetry.track", () => {
  it("posts an allowlisted event to PostHog", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(deps.fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = deps.fetchImpl.mock.calls[0];
    expect(String(url)).toContain("us.i.posthog.com");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.api_key).toBe("phc_test");
    expect(body.event).toBe("init_started");
    expect(body.distinct_id).toBe("id-1");
    expect(body.properties.framework).toBe("next");
    expect(body.properties.vendoVersion).toBe("9.9.9");
  });

  it("does not post when consent is denied", async () => {
    const deps = makeDeps({ env: { DO_NOT_TRACK: "1" } });
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not post when no PostHog key is configured", async () => {
    const deps = makeDeps({ posthogKey: undefined });
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("drops keys outside the event allowlist", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next", sourceCode: "secret" } as never);
    const body = JSON.parse((deps.fetchImpl.mock.calls[0][1] as { body: string }).body);
    expect(body.properties.sourceCode).toBeUndefined();
    expect(body.properties.framework).toBe("next");
  });

  it("caps oversized string values on an allowed key (review)", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "a".repeat(5000) });
    const body = JSON.parse((deps.fetchImpl.mock.calls[0][1] as { body: string }).body);
    expect(body.properties.framework.length).toBeLessThanOrEqual(512);
  });

  it("drops object/array values even on an allowed key (review)", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: { nested: "secret" } } as never);
    const body = JSON.parse((deps.fetchImpl.mock.calls[0][1] as { body: string }).body);
    expect(body.properties.framework).toBeUndefined();
  });

  it("includes projectIdHash and packageManager base props on every event", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vendo-tele-client-"));
    try {
      mkdirSync(join(cwd, ".git"));
      writeFileSync(join(cwd, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/a/b.git\n');
      const deps = makeDeps({
        cwd,
        env: { npm_config_user_agent: "pnpm/9.1.0 npm/? node/v20.11.0 darwin arm64" },
      });
      const t = createTelemetry(deps);
      await t.track("agent_run", {});
      const body = JSON.parse((deps.fetchImpl.mock.calls[0][1] as { body: string }).body);
      expect(body.properties.packageManager).toBe("pnpm");
      expect(body.properties.projectIdHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("omits projectIdHash and packageManager when no source exists", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vendo-tele-client-"));
    try {
      const deps = makeDeps({ cwd });
      const t = createTelemetry(deps);
      await t.track("agent_run", {});
      const body = JSON.parse((deps.fetchImpl.mock.calls[0][1] as { body: string }).body);
      expect("projectIdHash" in body.properties).toBe(false);
      expect("packageManager" in body.properties).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("never throws when fetch rejects", async () => {
    const deps = makeDeps({ fetchImpl: vi.fn().mockRejectedValue(new Error("network")) });
    const t = createTelemetry(deps);
    await expect(t.track("agent_run", {})).resolves.toBeUndefined();
  });

  it("returns after the telemetry timeout when fetch never settles", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({ fetchImpl: vi.fn(() => new Promise(() => {})) });
      const t = createTelemetry(deps);
      const tracked = t.track("init_started", { framework: "next" });

      await vi.advanceTimersByTimeAsync(1500);

      await expect(tracked).resolves.toBeUndefined();
      expect(deps.fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
